// Wire types shared with the frontend (frontend/src/types/index.ts).

import type { ChatItem } from "./rpc-contract.js";

export interface NATSMessage {
  method: string;
  parameters: Record<string, unknown>;
  correlation_id?: string;
}

export interface NATSResponse {
  result?: unknown;
  error?: string;
}

export type StreamEvent =
  /** A chat item added or changed; the frontend upserts it by id (chat-items.ts). */
  | { type: "item"; chat_id: string; item: ChatItem }
  /** Ends every accepted turn, whatever its outcome (chat-turn.ts). */
  | { type: "chat_finished"; chat_id: string; status: TurnStatus; error?: string };

export type TurnStatus = "done" | "stopped" | "error";

export interface StreamEnvelope {
  type: "chat";
  session_id: string;
  timestamp: number;
  data: StreamEvent;
}
