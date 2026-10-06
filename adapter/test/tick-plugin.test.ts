import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// dsh-plugins/tick.js resolves ~/.claude at import, so HOME is set first.
const home = mkdtempSync(path.join(tmpdir(), "tick-home-"));
const claude = path.join(home, ".claude");
const project = path.join(home, "proj");

type Listener = (payload: { agent: FakeAgent }) => void;
interface FakeAgent { session: { header: { delegationDepth?: number } }; steered: string[]; steer(m: { content: { text: string }[] }): void }

let stopping: Listener;
const agent = (depth?: number): FakeAgent => ({
  session: { header: { delegationDepth: depth } },
  steered: [],
  steer(m) { this.steered.push(m.content[0]!.text); },
});

beforeAll(async () => {
  process.env.HOME = home;
  const pluginPath = "../dsh-plugins/tick.js";
  const plugin = await import(pluginPath);
  plugin.apply({
    on: (event: string, fn: Listener) => { if (event === "agent/turn-stopping") stopping = fn; },
    logger: { warn: () => undefined },
  });
});

beforeEach(() => {
  rmSync(claude, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  mkdirSync(path.join(claude, "commands"), { recursive: true });
  mkdirSync(project);
  writeFileSync(path.join(claude, "commands", "tick.md"), "---\nx: y\n---\n# /tick\n\n$ARGUMENTS\n");
  writeFileSync(path.join(claude, ".harness_active"), "");
  writeFileSync(path.join(claude, ".harness_dir"), `${project}\n`);
});

describe("tick plugin", () => {
  it("steers a top-level turn into the next round with the expanded orchestrator", () => {
    const a = agent();
    stopping({ agent: a });
    expect(a.steered).toHaveLength(1);
    expect(a.steered[0]).toMatch(/^# \/tick\n\n\(No new message/);
  });

  it("lets the turn stop when auto mode is off, paused, complete, or in a subagent", () => {
    const sub = agent(1);
    stopping({ agent: sub });
    expect(sub.steered).toHaveLength(0);

    writeFileSync(path.join(project, "progress.md"), "## Plan\n\n## Status: complete\n");
    const done = agent();
    stopping({ agent: done });
    expect(done.steered).toHaveLength(0);

    rmSync(path.join(project, "progress.md"));
    writeFileSync(path.join(claude, ".tick_paused"), "");
    const paused = agent();
    stopping({ agent: paused });
    expect(paused.steered).toHaveLength(0);

    rmSync(path.join(claude, ".tick_paused"));
    rmSync(path.join(claude, ".harness_active"));
    const off = agent();
    stopping({ agent: off });
    expect(off.steered).toHaveLength(0);
  });

  it("caps the rounds of one turn, then starts fresh on the next turn", () => {
    const a = agent();
    for (let i = 0; i < 41; i++) stopping({ agent: a });
    expect(a.steered).toHaveLength(40); // the 41st stop is let through
    stopping({ agent: a });
    expect(a.steered).toHaveLength(41);
  });
});
