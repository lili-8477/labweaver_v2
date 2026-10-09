// Reads the Agent Team roster and task board that dsh-plugins/team-board.js
// mirrors to $DSH_HOME/team/<lead session id>.json, since dsh sends none of it
// over ACP. Shapes follow dsh-experimental-agent-team's listMembers/listTasks.

import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface TeamMember {
  /** Session id; a teammate's is its subagent session. */
  id: string;
  name: string;
  role: "lead" | "teammate";
  status: "running" | "inactive" | "provisioning" | "failed";
  description?: string;
  model?: string;
}

export interface TeamTask {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed";
  ownerName?: string;
  blockedBy: string[];
  ready: boolean;
}

export interface TeamBoard {
  members: TeamMember[];
  tasks: TeamTask[];
  updatedAt: number;
}

/** DeepSeek Harness state directory (sessions, config, plugin output). */
export const dshHome = (home: string): string => process.env.DSH_HOME ?? path.join(home, ".dsh");

/** The team led by this session; null when it never had teammates or tasks. */
export async function readTeamBoard(home: string, sessionId: string): Promise<TeamBoard | null> {
  const raw = await fs.readFile(path.join(dshHome(home), "team", `${sessionId}.json`), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as TeamBoard;
  } catch {
    return null;
  }
}
