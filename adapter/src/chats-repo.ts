import type { Pool } from "pg";
import type { ChatMode } from "./modes.js";

export interface ChatRow {
  chat_id: string;
  username: string;
  session_id: string | null;
  name: string;
  active_agent: string | null;
  /** Workspace-relative project dir (e.g. "local_projects/foo-1a2b") or null
   *  for chats that aren't bound to a project. When set, the agent cd's here
   *  and harness lookups read this dir's progress.md. */
  project_dir: string | null;
  mode: ChatMode;
  /** The chat this one was branched from as a sub-session, or null. */
  parent_chat_id: string | null;
  created_at: string;
  last_used_at: string;
  deleted_at: string | null;
}

export interface ChatInfo {
  id: string;
  name: string;
  last_activity_date: string;
  project_name: string;
  /** Same as ChatRow.project_dir — included so the UI can show the binding
   *  without a second round-trip. */
  project_dir: string | null;
  mode: ChatMode;
  active_agent: string | null;
  parent_chat_id: string | null;
}

/**
 * All chat CRUD for one tenant. Username is injected at construction and
 * every query filters on it — no path lets a crafted chat_id read or mutate
 * another tenant's data. This is the one and only query surface for chats
 * in the adapter.
 */
export class ChatsRepo {
  constructor(private pool: Pool, private username: string) {}

  async create(chatId: string, name: string, projectDir: string | null = null): Promise<void> {
    await this.pool.query(
      `INSERT INTO chats (chat_id, username, name, project_dir)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (chat_id) DO NOTHING`,
      [chatId, this.username, name, projectDir],
    );
  }

  /** Create a sub-session of `parentId`, inheriting its project binding and
   *  mode. Returns false (and creates nothing) when the parent isn't one of
   *  this tenant's live chats. */
  async createChild(chatId: string, name: string, parentId: string): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO chats (chat_id, username, name, parent_chat_id, project_dir, mode)
       SELECT $1, $2, $3, p.chat_id, p.project_dir, p.mode
       FROM chats p
       WHERE p.chat_id = $4 AND p.username = $2 AND p.deleted_at IS NULL
       ON CONFLICT (chat_id) DO NOTHING`,
      [chatId, this.username, name, parentId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async read(chatId: string): Promise<ChatRow | null> {
    const r = await this.pool.query(
      `SELECT chat_id, username, session_id, name, active_agent, project_dir, mode,
              parent_chat_id, created_at, last_used_at, deleted_at
       FROM chats
       WHERE chat_id = $1 AND username = $2 AND deleted_at IS NULL`,
      [chatId, this.username],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return {
      chat_id: row.chat_id,
      username: row.username,
      session_id: row.session_id,
      name: row.name,
      active_agent: row.active_agent,
      project_dir: row.project_dir,
      mode: row.mode,
      parent_chat_id: row.parent_chat_id,
      created_at: row.created_at.toISOString(),
      last_used_at: row.last_used_at.toISOString(),
      deleted_at: row.deleted_at ? row.deleted_at.toISOString() : null,
    };
  }

  async list(): Promise<ChatInfo[]> {
    const r = await this.pool.query(
      `SELECT
         c.chat_id        AS id,
         COALESCE(NULLIF(c.name, 'New chat'), s.title, s.first_user_text, c.name) AS name,
         c.last_used_at   AS last_used_at,
         c.active_agent   AS active_agent,
         c.project_dir    AS project_dir,
         c.mode           AS mode,
         c.parent_chat_id AS parent_chat_id,
         COALESCE(s.project_display, '') AS project_name
       FROM chats c
       LEFT JOIN sessions s ON s.session_id = c.session_id
       WHERE c.username = $1
         AND c.deleted_at IS NULL
         AND (s.is_sidechain IS DISTINCT FROM true)
       ORDER BY c.last_used_at DESC
       LIMIT 1000`,
      [this.username],
    );
    return r.rows.map((row) => ({
      id: row.id,
      name: row.name,
      last_activity_date: row.last_used_at.toISOString(),
      project_name: row.project_name,
      project_dir: row.project_dir,
      mode: row.mode,
      active_agent: row.active_agent,
      parent_chat_id: row.parent_chat_id,
    }));
  }

  async updateName(chatId: string, name: string): Promise<void> {
    await this.pool.query(
      `UPDATE chats SET name = $3, last_used_at = now()
       WHERE chat_id = $1 AND username = $2 AND deleted_at IS NULL`,
      [chatId, this.username, name],
    );
  }

  /** Bind a chat to a project directory. Pass null to unbind. The path is
   *  expected to be workspace-relative (no leading slash, no `..`). The RPC
   *  layer normalizes before calling — we trust the caller here. */
  async setProjectDir(chatId: string, projectDir: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE chats SET project_dir = $3
       WHERE chat_id = $1 AND username = $2 AND deleted_at IS NULL`,
      [chatId, this.username, projectDir],
    );
  }

  async setMode(chatId: string, mode: ChatMode): Promise<void> {
    await this.pool.query(
      `UPDATE chats SET mode = $3
       WHERE chat_id = $1 AND username = $2 AND deleted_at IS NULL`,
      [chatId, this.username, mode],
    );
  }

  async setSessionUuid(chatId: string, sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE chats SET session_id = $3, last_used_at = now()
       WHERE chat_id = $1 AND username = $2 AND deleted_at IS NULL
         AND (session_id IS NULL OR session_id <> $3::uuid)`,
      [chatId, this.username, sessionId],
    );
  }

  async touch(chatId: string): Promise<void> {
    await this.pool.query(
      `UPDATE chats SET last_used_at = now()
       WHERE chat_id = $1 AND username = $2 AND deleted_at IS NULL`,
      [chatId, this.username],
    );
  }

  async delete(chatId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM chats WHERE chat_id = $1 AND username = $2`,
      [chatId, this.username],
    );
  }
}
