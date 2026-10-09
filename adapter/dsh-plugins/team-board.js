// DeepSeek Harness plugin "team-board". dsh loads this file itself, so it is
// plain ESM, not TypeScript. Mounted by the adapter's cordis patch: see
// src/dsh/patch.ts.
//
// dsh keeps each Agent Team's roster and task board in the Lead's session but
// sends none of it over ACP. This mirrors them to
// $DSH_HOME/team/<lead session id>.json whenever a team member's session
// changes, for the Agents panel (src/dsh/team-board.ts). Every top-level
// session is a Lead, so only sessions that actually have teammates or tasks
// are written.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "team-board";
export const inject = ["agents", "agentTeams"];

const DIR = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "team");
const DEBOUNCE_MS = 250;

export function apply(ctx) {
  mkdirSync(DIR, { recursive: true });
  const pending = new Map(); // lead session id -> timer

  const write = (lead) => {
    pending.delete(lead.id);
    try {
      const members = ctx.agentTeams.listMembers(lead);
      const tasks = ctx.agentTeams.listTasks(lead);
      if (members.length <= 1 && tasks.length === 0) return;
      const file = join(DIR, `${lead.id}.json`);
      writeFileSync(`${file}.tmp`, JSON.stringify({ members, tasks, updatedAt: Date.now() }));
      renameSync(`${file}.tmp`, file); // readers never see a partial file
    } catch (e) {
      ctx.logger.warn(`team-board: ${e instanceof Error ? e.message : e}`);
    }
  };

  const touch = (agent) => {
    const membership = agent && ctx.agentTeams.tryMembership(agent);
    if (!membership || pending.has(membership.root.id)) return;
    pending.set(membership.root.id, setTimeout(() => write(membership.root), DEBOUNCE_MS));
  };

  ctx.on("session/event", (session) => touch(ctx.agents.get(session.header.id)));
  ctx.on("agent/status", ({ agent }) => touch(agent));
}
