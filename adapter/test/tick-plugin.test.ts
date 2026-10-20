import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// dsh-plugins/tick.js resolves ~/.labweaver at import, so HOME is set first.
const home = mkdtempSync(path.join(tmpdir(), "tick-home-"));
const lw = path.join(home, ".labweaver");
const project = path.join(home, "proj");
const progress = path.join(project, "progress.md");

type Listener = (payload: { agent: FakeAgent }) => void;
interface FakeAgent { id: string; session: { header: { delegationDepth?: number } }; steered: string[]; steer(m: { content: { text: string }[] }): void }

let stopping: Listener;
let nextStep: (md: string | null) => { agent?: string; work?: string; complete?: boolean };
const SID = "sess-1";
const sessionFile = path.join(lw, "auto", SID);
const agent = (depth?: number): FakeAgent => ({
  id: SID,
  session: { header: { delegationDepth: depth } },
  steered: [],
  steer(m) { this.steered.push(m.content[0]!.text); },
});

const md = (sections: Record<string, string[]>, extra = ""): string =>
  Object.entries(sections).map(([h, lines]) => `## ${h}\n${lines.join("\n")}\n`).join("\n") + extra;

beforeAll(async () => {
  process.env.HOME = home;
  const pluginPath = "../dsh-plugins/tick.js";
  const plugin = await import(pluginPath);
  nextStep = plugin.nextStep;
  plugin.apply({
    on: (event: string, fn: Listener) => { if (event === "agent/turn-stopping") stopping = fn; },
    logger: { warn: () => undefined },
  });
});

beforeEach(() => {
  rmSync(lw, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  mkdirSync(path.join(lw, "auto"), { recursive: true });
  mkdirSync(project);
  writeFileSync(sessionFile, `${project}\n`);
});

describe("nextStep (tick priority)", () => {
  it("bootstraps a missing project, then plans an empty plan", () => {
    expect(nextStep(null).agent).toBe("tick-bootstrap");
    expect(nextStep(md({ Pipeline: ["sc"], Plan: [], "Review feedback": [] })).agent).toBe("tick-planner");
  });

  it("puts review feedback before review, review before new work", () => {
    const plan = ["☑ qc — filter cells", "☐ norm — normalise"];
    expect(nextStep(md({ Plan: plan, "Review feedback": ["☐ 2026-10-06 reviewer: qc rejected: n_cells"] })))
      .toEqual({ agent: "tick-executor", work: "☐ 2026-10-06 reviewer: qc rejected: n_cells" });
    expect(nextStep(md({ Plan: plan, "Review feedback": ["☑ old item"] })))
      .toEqual({ agent: "tick-reviewer", work: "☑ qc — filter cells" });
    expect(nextStep(md({ Plan: ["☑ qc (reviewed)", "☐ norm — normalise"], "Review feedback": [] })))
      .toEqual({ agent: "tick-executor", work: "☐ norm — normalise" });
  });

  it("runs the retrospective last, then completes", () => {
    const done = md({ Plan: ["☑ qc (reviewed)"], "Review feedback": [] });
    expect(nextStep(done).agent).toBe("tick-retrospective");
    expect(nextStep(done + "## Retrospective: done (1 experiences)\n")).toEqual({ complete: true });
  });

  it("does not mistake a longer heading for the section", () => {
    expect(nextStep(md({ "Planner notes": ["x"], Plan: [] })).agent).toBe("tick-planner");
  });
});

describe("tick plugin loop", () => {
  it("steers a top-level turn to do the next step itself", () => {
    writeFileSync(progress, md({ Plan: ["☐ qc — filter cells"], "Review feedback": [] }));
    const a = agent();
    stopping({ agent: a });
    expect(a.steered).toEqual([
      `[auto mode · round 1] Do \`tick-executor\` now, yourself.\nAgent file: ${lw}/agents/tick-executor.md\n` +
      `Project directory: ${project}\nProject file: ${sessionFile}\nWork item: ☐ qc — filter cells\n` +
      `Follow the Do procedure in ${lw}/commands/tick.md.`,
    ]);
  });

  it("dispatches the reviewer as a subagent", () => {
    writeFileSync(progress, md({ Plan: ["☑ qc — filter cells"], "Review feedback": [] }));
    const a = agent();
    stopping({ agent: a });
    expect(a.steered[0]).toMatch(/^\[auto mode · round 1\] Dispatch `tick-reviewer` now\.\n/);
    expect(a.steered[0]).toMatch(/Follow the Dispatch procedure in /);
  });

  it("marks a finished project complete and lets the turn stop", () => {
    writeFileSync(progress, md({ Plan: ["☑ qc (reviewed)"], "Review feedback": [] }, "## Retrospective: done\n"));
    const a = agent();
    stopping({ agent: a });
    expect(a.steered).toHaveLength(0);
    expect(readFileSync(progress, "utf8")).toMatch(/## Status: complete\n$/);
  });

  it("lets the turn stop in a subagent, when paused, or with auto mode off", () => {
    const sub = agent(1);
    stopping({ agent: sub });
    expect(sub.steered).toHaveLength(0);

    writeFileSync(path.join(lw, ".tick_paused"), "");
    const paused = agent();
    stopping({ agent: paused });
    expect(paused.steered).toHaveLength(0);

    rmSync(path.join(lw, ".tick_paused"));
    rmSync(sessionFile);
    const off = agent();
    stopping({ agent: off });
    expect(off.steered).toHaveLength(0);
  });

  it("stops when the same step repeats without progress", () => {
    writeFileSync(sessionFile, ""); // bootstrap never records a project
    const a = agent();
    for (let i = 0; i < 4; i++) stopping({ agent: a });
    expect(a.steered).toHaveLength(3); // the 4th identical dispatch is refused
  });

  it("caps the rounds of one turn", () => {
    const a = agent();
    for (let i = 0; i < 41; i++) {
      // A different work item every round, so only the round cap applies.
      writeFileSync(progress, md({ Plan: [`☐ step-${i}`], "Review feedback": [] }));
      stopping({ agent: a });
    }
    expect(a.steered).toHaveLength(40); // the 41st stop is let through
  });
});

describe("outcome loop", () => {
  let sent: Array<{ url: string; body: { username: string; outcome: string; since: string } }>;
  beforeEach(() => {
    sent = [];
    process.env.MEMORY_API_URL = "http://indexer:8400";
    process.env.USERNAME = "alice";
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}");
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const review = (a: FakeAgent, after: string) => {
    writeFileSync(progress, md({ Plan: ["☑ qc — filter cells", "☐ norm — normalise"], "Review feedback": [] }));
    stopping({ agent: a }); // dispatches the reviewer on qc
    writeFileSync(progress, after);
    stopping({ agent: a }); // the review round ended
  };

  it("credits an approval as a success, from the turn's start", () => {
    const a = agent();
    const turnStart = new Date(Date.now() - 5000);
    utimesSync(sessionFile, turnStart, turnStart);
    review(a, md({ Plan: ["- ☑ (reviewed) qc   filter cells | n=2638", "☐ norm — normalise"], "Review feedback": [] }));
    expect(sent).toEqual([{ url: "http://indexer:8400/memory/outcome", body: { username: "alice", outcome: "success", since: turnStart.toISOString() } }]);
  });

  it("credits a rejection as a failure, and starts the next window at the verdict", () => {
    const a = agent();
    review(a, md({ Plan: ["☑ qc — filter cells", "☐ norm — normalise"], "Review feedback": ["☐ 2026-10-20 reviewer: qc rejected: n_cells: expected >2000, got 12"] }));
    expect(sent.map((s) => s.body.outcome)).toEqual(["failure"]);
    // The executor fixes it, the reviewer approves: a second window.
    writeFileSync(progress, md({ Plan: ["☑ qc — filter cells", "☐ norm — normalise"], "Review feedback": ["☑ 2026-10-20 reviewer: qc rejected: fixed"] }));
    stopping({ agent: a }); // reviewer again
    writeFileSync(progress, md({ Plan: ["☑ (reviewed) qc — filter cells", "☐ norm — normalise"], "Review feedback": [] }));
    stopping({ agent: a });
    expect(sent.map((s) => s.body.outcome)).toEqual(["failure", "success"]);
    expect(sent[1]!.body.since >= sent[0]!.body.since).toBe(true);
  });

  it("reports nothing when a review did not finish", () => {
    const a = agent();
    review(a, md({ Plan: ["☑ qc — filter cells", "☐ norm — normalise"], "Review feedback": [] }));
    expect(sent).toEqual([]);
  });
});

