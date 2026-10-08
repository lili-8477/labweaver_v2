// Harness-neutral seam between the RPC layer and whatever agent runtime
// executes a turn. Engines translate their native stream into AgentEvents;
// turn-runner.ts fans those out to the frontend stream and the transcript.

import type { ImageRef } from "../rpc.js";

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; output: string; isError: boolean }
  /** Context-window occupancy after a step (DSH reports no per-call split). */
  | { kind: "usage"; contextTokens: number; contextWindow: number }
  /** Token totals for the whole turn, emitted once after it ends. */
  | ({ kind: "tokens" } & TurnTokens);

export interface TurnTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface EngineTurnArgs {
  prompt: string;
  images: ImageRef[];
  cwd: string;
  /** Session to continue; undefined starts a new one. */
  resumeSessionId: string | undefined;
  /** "provider/model" reference (see providers/registry.ts). */
  model: string;
  signal: AbortSignal;
  /** Called once with the session id the turn actually runs in; awaited before the prompt is sent. */
  onSessionId: (sessionId: string) => void | Promise<void>;
  onEvent: (ev: AgentEvent) => void;
}

export interface AgentEngine {
  runTurn(args: EngineTurnArgs): Promise<void>;
  close(): Promise<void>;
}
