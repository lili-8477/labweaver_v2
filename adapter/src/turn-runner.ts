// Runs one chat turn on an AgentEngine. Every engine event becomes a
// Claude-format transcript entry (memory indexer, history); each entry is
// also projected into chat items as it is created, and the items it changed
// stream to the frontend — the same projection get_chat_items applies to the
// stored transcript (chat-items.ts).

import { ChatItemProjector } from "./chat-items.js";
import type { AgentEngine, ImageRef } from "./engine/types.js";
import { expandSlashCommand } from "./slash-commands.js";
import { ClaudeTranscriptWriter } from "./transcript/claude-jsonl.js";
import type { StreamEvent } from "./types.js";

export interface RunTurnArgs {
  chatId: string;
  prompt: string;
  images: ImageRef[];
  cwd: string;
  home: string;
  /** "provider/model" reference. */
  model: string;
  resumeSessionId: string | undefined;
  signal: AbortSignal;
  onEvent: (ev: StreamEvent) => void;
  onSessionId: (sessionId: string) => void | Promise<void>;
}

export async function runTurn(engine: AgentEngine, args: RunTurnArgs): Promise<void> {
  const { chatId, home, cwd, model, signal } = args;
  const items = new ChatItemProjector();
  let writer: ClaudeTranscriptWriter | undefined;

  console.log(`[turn] chat=${chatId.slice(0, 8)} model=${model} resume=${args.resumeSessionId?.slice(0, 8) ?? "none"} imgs=${args.images.length}`);
  try {
    await engine.runTurn({
      prompt: await expandSlashCommand(home, args.prompt),
      images: args.images,
      cwd,
      model,
      resumeSessionId: args.resumeSessionId,
      signal,
      onSessionId: async (sessionId) => {
        writer = new ClaudeTranscriptWriter({
          home, cwd, sessionId, model,
          onEntry: (entry) => {
            for (const item of items.push(entry)) args.onEvent({ type: "item", chat_id: chatId, item });
          },
        });
        if (args.resumeSessionId && args.resumeSessionId !== sessionId) writer.continues(args.resumeSessionId);
        writer.userPrompt(args.prompt);
        await args.onSessionId(sessionId);
      },
      onEvent: (ev) => writer?.event(ev),
    });
  } finally {
    await writer?.flush();
  }
}
