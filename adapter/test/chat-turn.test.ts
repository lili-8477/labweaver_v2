import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { applyIndexerMigrations } from "./helpers/apply-migrations.js";
import { ChatsRepo } from "../src/chats-repo.js";
import { ChatTurns } from "../src/chat-turn.js";
import type { AgentEngine, EngineTurnArgs } from "../src/engine/types.js";
import { sessionFile } from "../src/harness.js";
import type { StreamEvent } from "../src/types.js";

const SID = "ae132e5b-0f2a-4428-a3cf-c057a8829659";
const CHAT = "11111111-1111-1111-1111-111111111111";

type Script = (args: EngineTurnArgs) => Promise<void>;

/** Opens session SID, says one thing, then runs the test's script. */
class ScriptedEngine implements AgentEngine {
  calls: EngineTurnArgs[] = [];
  script: Script = async () => undefined;
  async runTurn(args: EngineTurnArgs): Promise<void> {
    this.calls.push(args);
    await args.onSessionId(SID);
    args.onEvent({ kind: "text", text: "ok" });
    await this.script(args);
  }
  async close(): Promise<void> {}
}

const untilAborted: Script = (args) =>
  new Promise((resolve) => {
    if (args.signal.aborted) return resolve();
    args.signal.addEventListener("abort", () => resolve());
  });

let pg: StartedPostgreSqlContainer;
let pool: Pool;
let tmp: string;
let home: string;
let ws: string;
let chats: ChatsRepo;
let engine: ScriptedEngine;
let events: StreamEvent[];
let turns: ChatTurns;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await applyIndexerMigrations(pool);
}, 90_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

beforeEach(async () => {
  await pool.query("DELETE FROM chats");
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chat-turn-"));
  home = path.join(tmp, "home");
  ws = path.join(tmp, "workspace");
  await fs.mkdir(ws, { recursive: true });
  chats = new ChatsRepo(pool, "alice");
  engine = new ScriptedEngine();
  events = [];
  turns = new ChatTurns({
    engine, chats, home, workspaceRoot: ws, defaultProjectCwd: ws,
    currentModel: async () => "m/x",
    publishStream: (_id, ev) => events.push(ev),
  });
});

afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const finished = () => events.filter((e) => e.type === "chat_finished");

describe("ChatTurns", () => {
  it("runs one turn per chat and ends a stopped one with chat_finished", async () => {
    await chats.create(CHAT, "c");
    engine.script = untilAborted;
    const { done } = await turns.start(CHAT, { text: "hi", images: [] });
    expect(turns.activeTurn(CHAT)).toEqual({ auto: false });
    await expect(turns.start(CHAT, { text: "again", images: [] })).rejects.toThrow(/already streaming/);

    expect(turns.stop(CHAT)).toBe(true);
    expect(await done).toEqual({ status: "stopped" });
    expect(finished()).toEqual([{ type: "chat_finished", chat_id: CHAT, status: "stopped" }]);
    expect(turns.activeTurn(CHAT)).toBeNull();
    expect(turns.stop(CHAT)).toBe(false);

    engine.script = async () => undefined;
    expect(await (await turns.start(CHAT, { text: "hi", images: [] })).done).toEqual({ status: "done" });
  });

  it("rejects a missing chat without reserving it", async () => {
    await expect(turns.start(CHAT, { text: "hi", images: [] })).rejects.toThrow(/chat not found/);
    expect(turns.count).toBe(0);
    expect(finished()).toEqual([]);
  });

  it("reports an engine failure as an error outcome", async () => {
    await chats.create(CHAT, "c");
    engine.script = async () => { throw new Error("provider down"); };
    const { done } = await turns.start(CHAT, { text: "hi", images: [] });
    expect(await done).toEqual({ status: "error", error: "provider down" });
    expect(finished()).toEqual([{ type: "chat_finished", chat_id: CHAT, status: "error", error: "provider down" }]);
  });

  it("gives the first turn its project context, then resumes the saved session", async () => {
    await chats.create(CHAT, "c", "local_projects/p");
    await (await turns.start(CHAT, { text: "hello", images: [] })).done;
    expect(engine.calls[0]!.prompt).toContain(`project at ${path.join(ws, "local_projects/p")}`);
    expect(engine.calls[0]!.resumeSessionId).toBeUndefined();
    expect(engine.calls[0]!.cwd).toBe(ws);
    await vi.waitFor(async () => expect((await chats.read(CHAT))!.session_id).toBe(SID));

    await (await turns.start(CHAT, { text: "hello again", images: [] })).done;
    expect(engine.calls[1]!.prompt).toBe("hello again");
    expect(engine.calls[1]!.resumeSessionId).toBe(SID);
  });

  it("gives a sub-session's first turn its parent's context", async () => {
    const child = "22222222-2222-2222-2222-222222222222";
    await chats.create(CHAT, "parent chat");
    await chats.setSessionUuid(CHAT, "bbbbbbbb-0f2a-4428-a3cf-c057a8829659");
    await chats.createChild(child, "child", CHAT);
    await (await turns.start(child, { text: "go on", images: [] })).done;
    expect(engine.calls[0]!.prompt).toMatch(/^go on\n/);
    expect(engine.calls[0]!.prompt).toContain('branched from the chat "parent chat"');
  });

  it("runs an Auto turn once: chat flips back, the session is marked with its project", async () => {
    await chats.create(CHAT, "c", "local_projects/p");
    await chats.setMode(CHAT, "auto");
    let seen: { mode?: string; marker?: string; active?: unknown } = {};
    engine.script = async () => {
      seen = {
        mode: (await chats.read(CHAT))!.mode,
        marker: await fs.readFile(sessionFile(home, SID), "utf8"),
        active: turns.activeTurn(CHAT),
      };
    };
    const { done } = await turns.start(CHAT, { text: "build it", images: [] });
    expect((await chats.read(CHAT))!.mode).toBe("chat"); // already flipped at the ack
    await done;
    expect(engine.calls[0]!.prompt).toMatch(/^\/tick build it/);
    expect(seen).toEqual({ mode: "chat", marker: `${path.join(ws, "local_projects/p")}\n`, active: { auto: true } });
    expect((await chats.read(CHAT))!.mode).toBe("chat");
  });

  it("binds an unbound Auto chat to the project its run recorded", async () => {
    await chats.create(CHAT, "c");
    await chats.setMode(CHAT, "auto");
    engine.script = async () => {
      // What tick-bootstrap does once it has created the project.
      await fs.writeFile(sessionFile(home, SID), `${path.join(ws, "local_projects/new")}\n`);
    };
    await (await turns.start(CHAT, { text: "build it", images: [] })).done;
    expect((await chats.read(CHAT))!.project_dir).toBe("local_projects/new");
  });

  it("clears a stale Auto marker on a plain chat turn", async () => {
    await chats.create(CHAT, "c");
    await fs.mkdir(path.dirname(sessionFile(home, SID)), { recursive: true });
    await fs.writeFile(sessionFile(home, SID), "");
    await (await turns.start(CHAT, { text: "hi", images: [] })).done;
    await expect(fs.stat(sessionFile(home, SID))).rejects.toThrow();
    expect(engine.calls[0]!.prompt).toBe("hi");
  });
});
