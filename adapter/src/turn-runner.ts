// Runs one chat turn on an AgentEngine and fans its events out to:
//   - the frontend stream (EventTranslator → StreamEvent, contract unchanged)
//   - the Claude-format transcript (memory indexer + get_chat_messages)

import type { AgentEngine, AgentEvent } from "./engine/types.js";
import { EventTranslator, capToolOutput } from "./events.js";
import type { ImageRef } from "./rpc.js";
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
  onSessionId: (sessionId: string) => void;
}

export async function runTurn(engine: AgentEngine, args: RunTurnArgs): Promise<void> {
  const { chatId, home, cwd, model, signal } = args;
  const t = new EventTranslator();
  let writer: ClaudeTranscriptWriter | undefined;

  const handle = (ev: AgentEvent): void => {
    writer?.event(ev);
    switch (ev.kind) {
      case "text":
        args.onEvent(t.textDelta(ev.text, chatId));
        break;
      case "tool_call":
        args.onEvent(t.assistantToolCalls(chatId, undefined, [{ id: ev.id, name: ev.name, input: ev.input }]));
        break;
      case "tool_result":
        args.onEvent(t.toolResult(chatId, ev.id, capToolOutput(ev.output)));
        break;
      case "usage":
        // DSH reports context occupancy, not an input/output split.
        t.recordUsage(ev.contextTokens, 0);
        break;
    }
  };

  console.log(`[turn] chat=${chatId.slice(0, 8)} model=${model} resume=${args.resumeSessionId?.slice(0, 8) ?? "none"} imgs=${args.images.length}`);
  try {
    await engine.runTurn({
      prompt: await expandSlashCommand(home, args.prompt),
      images: args.images,
      cwd,
      model,
      resumeSessionId: args.resumeSessionId,
      signal,
      onSessionId: (sessionId) => {
        writer = new ClaudeTranscriptWriter({ home, cwd, sessionId, model });
        if (args.resumeSessionId && args.resumeSessionId !== sessionId) writer.continues(args.resumeSessionId);
        writer.userPrompt(args.prompt);
        args.onSessionId(sessionId);
      },
      onEvent: handle,
    });
  } finally {
    await writer?.flush();
  }

  if (!signal.aborted) {
    for (const ev of t.turnEnd(chatId, undefined)) args.onEvent(ev);
  }
}
