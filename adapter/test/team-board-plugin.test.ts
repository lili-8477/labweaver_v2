import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// dsh-plugins/team-board.js resolves $DSH_HOME at import, so it is set first.
const dshHome = mkdtempSync(path.join(tmpdir(), "team-board-"));
const teamFile = (id: string) => path.join(dshHome, "team", `${id}.json`);

type Agent = { id: string };
const lead: Agent = { id: "lead-1" };
const solo: Agent = { id: "solo-1" };
const mate: Agent = { id: "mate-1" };
const agents = new Map([lead, solo, mate].map((a) => [a.id, a]));
const members: Record<string, unknown[]> = {
  "lead-1": [{ name: "lead", role: "lead", status: "running" }, { name: "analyst", role: "teammate", status: "inactive" }],
  "solo-1": [{ name: "lead", role: "lead", status: "running" }],
};
const listeners: Record<string, (...a: any[]) => void> = {};

beforeAll(async () => {
  process.env.DSH_HOME = dshHome;
  const pluginPath = "../dsh-plugins/team-board.js";
  const plugin = await import(pluginPath);
  plugin.apply({
    on: (event: string, fn: (...a: any[]) => void) => { listeners[event] = fn; },
    logger: { warn: () => undefined },
    agents: { get: (id: string) => agents.get(id) },
    agentTeams: {
      // The teammate belongs to lead-1's team; every other agent leads its own.
      tryMembership: (a: Agent) => ({ root: a === mate ? lead : a }),
      listMembers: (root: Agent) => members[root.id],
      listTasks: (root: Agent) => (root === lead ? [{ id: "1", subject: "run QC", status: "pending", blockedBy: [], ready: true }] : []),
    },
  });
});

const settle = () => new Promise((r) => setTimeout(r, 300));

describe("team-board plugin", () => {
  it("mirrors a team to its lead's file when a teammate's session changes", async () => {
    listeners["session/event"]!({ header: { id: "mate-1" } }, {});
    await settle();
    const board = JSON.parse(readFileSync(teamFile("lead-1"), "utf8"));
    expect(board.members.map((m: { name: string }) => m.name)).toEqual(["lead", "analyst"]);
    expect(board.tasks[0].subject).toBe("run QC");
  });

  it("writes nothing for a lead with no teammates or tasks", async () => {
    listeners["agent/status"]!({ agent: solo });
    await settle();
    expect(existsSync(teamFile("solo-1"))).toBe(false);
  });
});
