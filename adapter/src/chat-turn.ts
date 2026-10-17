// Chat turns (GLOSSARY.md): one user message run on the agent engine until it
// ends or is stopped. This module owns everything a turn decides on the chat
// side — one turn per chat at a time, stop, first-turn context, mode routing,
// the Auto-mode marker, session capture and post-turn project binding — and
// ends every accepted turn with exactly one `chat_finished` carrying its status.
// turn-runner.ts is the engine side (stream translation, transcript).

import * as path from "node:path";
import type { ChatRow, ChatsRepo } from "./chats-repo.js";
import type { AgentEngine, ImageRef } from "./engine/types.js";
import { enterAutoMode, leaveAutoMode, recordedProject } from "./harness.js";
import { readSessionMessages, transcriptPath } from "./history.js";
import { modePrompt } from "./modes.js";
import { parentDigest, withSessionContext, type SessionContext } from "./session-context.js";
import { runTurn } from "./turn-runner.js";
import type { StreamEvent, TurnStatus } from "./types.js";

export interface ChatTurnDeps {
  engine: AgentEngine;
  chats: ChatsRepo;
  home: string;
  workspaceRoot: string;
  /** cwd every turn runs in (see run()). */
  defaultProjectCwd: string;
  /** Selected "provider/model", read at the start of each turn. */
  currentModel: () => Promise<string>;
  publishStream: (streamId: string, ev: StreamEvent) => void;
}

export interface TurnInput {
  text: string;
  images: ImageRef[];
}

export interface TurnOutcome {
  status: TurnStatus;
  error?: string;
}

interface ActiveTurn {
  ac: AbortController;
  /** This turn runs Auto mode (the chat itself has already flipped back to chat). */
  auto: boolean;
}

export class ChatTurns {
  private active = new Map<string, ActiveTurn>();

  constructor(private deps: ChatTurnDeps) {}

  /**
   * Accept a turn for `chatId` and start it. Rejects when the chat is missing
   * or already running a turn (concurrent turns corrupt the session JSONL).
   * Once accepted, `done` always resolves — never rejects — and the turn
   * publishes `chat_finished` with the same status.
   */
  async start(chatId: string, input: TurnInput): Promise<{ done: Promise<TurnOutcome> }> {
    if (this.active.has(chatId)) throw new Error(`chat ${chatId} is already streaming a turn`);
    // Reserve the slot before awaiting anything, so a second start can't slip in.
    const turn: ActiveTurn = { ac: new AbortController(), auto: false };
    this.active.set(chatId, turn);
    let chat: ChatRow;
    try {
      const row = await this.deps.chats.read(chatId);
      if (!row) throw new Error(`chat not found: ${chatId}`);
      chat = row;
      // Auto mode covers one request: the chat is back in plain chat mode by
      // the time the turn is acknowledged. The tick plugin keys off the
      // session file (enterAutoMode in run), so this run keeps going.
      turn.auto = chat.mode === "auto";
      if (turn.auto) await this.deps.chats.setMode(chatId, "chat");
    } catch (e) {
      this.active.delete(chatId);
      throw e;
    }
    return { done: this.run(chat, input, turn) };
  }

  /** Stop the chat's running turn; false when none is running. */
  stop(chatId: string): boolean {
    const turn = this.active.get(chatId);
    if (!turn) return false;
    turn.ac.abort();
    return true;
  }

  stopAll(): void {
    for (const turn of this.active.values()) turn.ac.abort();
  }

  /** The chat's running turn, or null. */
  activeTurn(chatId: string): { auto: boolean } | null {
    const turn = this.active.get(chatId);
    return turn ? { auto: turn.auto } : null;
  }

  /** Turns in flight. */
  get count(): number {
    return this.active.size;
  }

  private async run(chat: ChatRow, input: TurnInput, turn: ActiveTurn): Promise<TurnOutcome> {
    const { chats, home, workspaceRoot, defaultProjectCwd } = this.deps;
    const chatId = chat.chat_id;
    const signal = turn.ac.signal;
    let sessionId: string | undefined;
    let outcome: TurnOutcome;
    try {
      let prompt = input.text;
      if (!chat.session_id) prompt = await this.firstTurnContext(chat, prompt);
      prompt = modePrompt(chat.mode, prompt);
      // cwd stays at defaultProjectCwd even when the chat is bound to a
      // project. Transcripts live under ~/.claude/projects/<encoded-cwd>/ and
      // DSH resume requires the session's original cwd — switching cwd
      // mid-chat would fragment history and break resume. Auto mode hands the
      // agent its project through the session's file instead (harness.ts).
      await runTurn(this.deps.engine, {
        chatId,
        prompt,
        images: input.images,
        cwd: defaultProjectCwd,
        home,
        model: await this.deps.currentModel(),
        // Resume only if we've already captured a real session UUID.
        resumeSessionId: chat.session_id ?? undefined,
        signal,
        onEvent: (ev) => this.deps.publishStream(`chat_${chatId}`, ev),
        onSessionId: async (sid) => {
          sessionId = sid;
          await (turn.auto
            ? enterAutoMode(home, workspaceRoot, sid, chat.project_dir)
            : leaveAutoMode(home, sid));
          if (sid === chat.session_id) return;
          // Fire-and-forget — stash the real session UUID so next resume works.
          chats.setSessionUuid(chatId, sid).catch((e) => {
            console.warn(`[turn] failed to stash session_uuid for ${chatId}:`, e);
          });
        },
      });
      await chats.touch(chatId);
      outcome = { status: signal.aborted ? "stopped" : "done" };
    } catch (e) {
      outcome = signal.aborted
        ? { status: "stopped" }
        : { status: "error", error: e instanceof Error ? e.message : String(e) };
      if (outcome.status === "error") console.error(`[turn] chat ${chatId} failed:`, e);
    }
    // Bind the chat to the project tick-bootstrap created, so the next
    // message continues it rather than bootstrapping another.
    if (turn.auto && !chat.project_dir && sessionId) {
      const rel = await recordedProject(home, workspaceRoot, sessionId);
      if (rel) await chats.setProjectDir(chatId, rel).catch((e) => {
        console.warn(`[turn] failed to bind ${chatId} to ${rel}:`, e);
      });
    }
    this.active.delete(chatId);
    this.deps.publishStream(`chat_${chatId}`, { type: "chat_finished", chat_id: chatId, ...outcome });
    return outcome;
  }

  /** First turn of a fresh session: tell the agent its project and, for a
   *  sub-session, what the parent conversation covered. */
  private async firstTurnContext(chat: ChatRow, prompt: string): Promise<string> {
    const { chats, home, defaultProjectCwd, workspaceRoot } = this.deps;
    const ctx: SessionContext = {};
    if (chat.project_dir) ctx.projectDir = path.resolve(workspaceRoot, chat.project_dir);
    const parent = chat.parent_chat_id ? await chats.read(chat.parent_chat_id) : null;
    if (parent?.session_id) {
      const messages = await readSessionMessages(home, defaultProjectCwd, parent.session_id);
      ctx.parent = {
        name: parent.name,
        transcript: transcriptPath(home, defaultProjectCwd, parent.session_id),
        digest: parentDigest(messages),
      };
    }
    return withSessionContext(prompt, ctx);
  }
}
