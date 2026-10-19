// RPC dispatch: maps frontend method names to handlers. The frontend contract
// is pinned — see pantheon-frontend/src/stores/chat.ts for the list of calls.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { labweaverPath } from "./labweaver-dir.js";
import { ChatsRepo } from "./chats-repo.js";
import { ChatTurns } from "./chat-turn.js";
import { CHAT_MODES, MODE_COMMANDS, type ChatMode } from "./modes.js";
import { ChpcBridge, type OpenRequest } from "./chpc-bridge-rpc.js";
import type { FleetMonitor } from "./fleet-status.js";
import { FileManager } from "./fs-rpc.js";
import { projectItems, type ChatItem } from "./chat-items.js";
import { readTranscript } from "./transcript/read.js";
import { createProject, listProjects } from "./projects.js";
import { readChatStats } from "./chat-stats.js";
import { H5adService } from "./h5ad-rpc.js";
import { KernelBridge, type IOPubEvent } from "./kernel.js";
import { MemoryForwarder } from "./memory-rpc.js";
import { NotebookManager } from "./notebook-rpc.js";
import { ShareRpcClient } from "./share-rpc.js";
import { workspacePath } from "./workspace-path.js";
import { listOrgSkills } from "./org-skills-rpc.js";
import { listUserSkills, readUserSkillManifest } from "./skills-rpc.js";
import { listUserCommands } from "./commands-rpc.js";
import { acpProfileDir, listClientModules } from "./dsh-client-modules.js";
import type { AgentEngine, ImageRef } from "./engine/types.js";
import {
  findModel,
  listModelOptions,
  resolveModelRef,
  type ProviderSpec,
} from "./providers/registry.js";
import { readTeamBoard } from "./dsh/team-board.js";
import type { StreamEvent } from "./types.js";

export interface RpcDeps {
  serviceId: string;
  workspaceRoot: string;
  chats: ChatsRepo;
  home: string;
  defaultProjectCwd: string; // where `chat` runs by default (a project dir)
  publishStream: (streamId: string, ev: StreamEvent) => void;
  /** Raw NATS publish for non-chat streams (notebook IOPub, etc.). */
  publishRaw: (subject: string, envelope: Record<string, unknown>) => void;
  /** Subject for streams (frontend `pantheon.stream.<id>`). */
  streamSubject: (streamId: string) => string;
  /** Path to the Python kernel bridge script. */
  kernelBridgePath: string;
  /** Idle-cull threshold (ms). 0 disables automatic culling. */
  kernelIdleCullMs?: number;
  /** How often to check for cull (ms). Defaults to 60_000. */
  kernelCullCheckIntervalMs?: number;
  /** Memory API client. null when MEMORY_API_URL is not configured. */
  memory: MemoryForwarder | null;
  /** Share API client. null when MEMORY_API_URL is not configured. */
  share: ShareRpcClient | null;
  /** Agent runtime that executes chat turns (DeepSeek Harness in production). */
  engine: AgentEngine;
  /** Model providers offered to the frontend (providers/registry.ts). */
  providers: ProviderSpec[];
  /** Set only in the manager container: every container's status. */
  fleet?: FleetMonitor | null;
}

export class RpcRouter {
  private chats: ChatsRepo;
  private files: FileManager;
  private notebooks: NotebookManager;
  private h5ad: H5adService;
  private chpc: ChpcBridge;
  private turns: ChatTurns;

  constructor(private deps: RpcDeps) {
    this.chats = deps.chats;
    this.turns = new ChatTurns({
      engine: deps.engine,
      chats: deps.chats,
      home: deps.home,
      workspaceRoot: deps.workspaceRoot,
      defaultProjectCwd: deps.defaultProjectCwd,
      currentModel: () => this.currentModel(),
      publishStream: deps.publishStream,
    });
    this.files = new FileManager(deps.workspaceRoot);
    // CHPC bridge: publishes OpenEvent frames on pantheon.stream.chpc_bridge_events.
    this.chpc = new ChpcBridge(deps.home, (ev) => {
      const subject = deps.streamSubject("chpc_bridge_events");
      deps.publishRaw(subject, {
        type: "chpc_bridge",
        session_id: deps.serviceId,
        timestamp: Date.now() / 1000,
        data: ev,
      });
    });
    // Kernel session_id = `<prefix>_<hash-of-notebook-path>`. One kernel
    // per notebook so their variable namespaces don't bleed together.
    const kernelSessionPrefix = `k_${deps.serviceId.slice(0, 16)}`;
    const kernelFactory = (sessionId: string): KernelBridge =>
      new KernelBridge({
        bridgePath: deps.kernelBridgePath,
        sessionId,
        onIopub: (sid, ev) => this.publishIopub(sid, ev),
        cullIdleMs: deps.kernelIdleCullMs,
        cullCheckIntervalMs: deps.kernelCullCheckIntervalMs,
        onCulled: (sid, reason) => this.publishCulled(sid, reason),
      });
    this.notebooks = new NotebookManager(
      deps.workspaceRoot,
      kernelFactory,
      kernelSessionPrefix,
    );
    // h5ad viewer reuses the same kernel-factory contract (Python child
    // process, iopub republished to NATS) but pins a single session id so
    // the AnnData cache survives across plot calls.
    this.h5ad = new H5adService({
      serviceId: deps.serviceId,
      workspaceRoot: deps.workspaceRoot,
      kernelFactory,
    });
  }

  private settingsPath(): string {
    return labweaverPath(this.deps.home, "settings.json");
  }

  private async readSettings(): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(this.settingsPath(), "utf8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }

  private async writeSettings(obj: Record<string, unknown>): Promise<void> {
    await fs.writeFile(this.settingsPath(), JSON.stringify(obj, null, 2) + "\n", "utf8");
  }

  /** Selected "provider/model"; stale or legacy (Claude) values resolve to the default. */
  private async currentModel(): Promise<string> {
    const cur = await this.readSettings();
    return resolveModelRef(this.deps.providers, cur.model as string | undefined);
  }

  private publishCulled(
    sessionId: string,
    reason: { idleMs: number; thresholdMs: number },
  ): void {
    // Publish a synthetic iopub-style status message so any frontend listening
    // on notebook_iopub_<sessionId> learns the kernel was culled. Next
    // executeCell will respawn lazily.
    const subject = this.deps.streamSubject(`notebook_iopub_${sessionId}`);
    this.deps.publishRaw(subject, {
      type: "notebook",
      session_id: this.deps.serviceId,
      timestamp: Date.now() / 1000,
      data: {
        msg_type: "status",
        content: { execution_state: "dead", cull_reason: reason },
      },
      metadata: { cell_id: undefined },
    });
  }

  private publishIopub(sessionId: string, ev: IOPubEvent): void {
    const subject = this.deps.streamSubject(`notebook_iopub_${sessionId}`);
    this.deps.publishRaw(subject, {
      type: "notebook",
      session_id: this.deps.serviceId,
      timestamp: Date.now() / 1000,
      data: {
        msg_type: ev.msg_type,
        content: ev.content,
      },
      metadata: { cell_id: ev.cell_id ?? undefined },
    });
  }

  /** Counts for this container's fleet status report. */
  activity(): { activeTurns: number; kernels: number } {
    return { activeTurns: this.turns.count, kernels: this.notebooks.kernelCount };
  }

  abortAll(): void {
    this.turns.stopAll();
    this.notebooks.shutdownAll();
    this.h5ad.shutdown();
  }

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    const short = method === "chat"
      ? `chat(chat_id=${String(params.chat_id).slice(0, 8)}..., len=${(params.message as unknown[])?.length ?? 0})`
      : method;
    console.log(`[rpc] -> ${short}`);
    try {
      const result = await this.dispatchInner(method, params);
      console.log(`[rpc] <- ${method} ok`);
      return result;
    } catch (e) {
      console.error(`[rpc] <- ${method} err:`, e instanceof Error ? e.stack ?? e.message : e);
      throw e;
    }
  }

  private async dispatchInner(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (MemoryForwarder.handles(method)) {
      if (!this.deps.memory) throw new Error("memory api not configured");
      return this.deps.memory.call(method, params);
    }
    switch (method) {
      case "get_endpoint":
        return { success: true, service_id: this.deps.serviceId };

      case "get_model":
        return { success: true, model: await this.currentModel() };

      case "list_models":
        return { success: true, models: listModelOptions(this.deps.providers) };

      case "set_model": {
        const model = params.model as string;
        if (!model || typeof model !== "string") throw new Error("model required");
        if (!findModel(this.deps.providers, model)) throw new Error(`unknown model: ${model}`);
        const cur = await this.readSettings();
        cur.model = model;
        await this.writeSettings(cur);
        return { success: true, model };
      }

      case "list_chats": {
        const chats = (await this.chats.list()).map((c) => {
          const turn = this.turns.activeTurn(c.id);
          return { ...c, running: turn !== null, auto_running: turn?.auto ?? false };
        });
        return { success: true, chats };
      }

      case "create_chat": {
        const name = (params.chat_name as string | undefined) ?? "New chat";
        const parentId = (params.parent_chat_id as string | undefined)?.trim();
        const chatId = crypto.randomUUID();
        if (parentId) {
          if (!(await this.chats.createChild(chatId, name, parentId))) {
            throw new Error(`parent chat not found: ${parentId}`);
          }
        } else {
          await this.chats.create(chatId, name, this.projectDirParam(params.project_dir));
        }
        return { success: true, chat_id: chatId };
      }

      case "list_projects":
        return { success: true, projects: await listProjects(this.deps.workspaceRoot) };

      case "create_project": {
        const name = (params.name as string | undefined)?.trim();
        if (!name) throw new Error("name required");
        return { success: true, project: await createProject(this.deps.workspaceRoot, name) };
      }

      case "delete_chat": {
        const chatId = params.chat_id as string;
        this.turns.stop(chatId);
        await this.chats.delete(chatId);
        return { success: true };
      }

      case "update_chat_name": {
        const chatId = params.chat_id as string;
        const name = params.chat_name as string;
        await this.chats.updateName(chatId, name);
        return { success: true };
      }

      case "get_chat_items": {
        const chatId = params.chat_id as string;
        const chat = await this.chats.read(chatId);
        // Use the real engine session UUID if we have one, else fall back to chat_id.
        const sessionUuid = chat?.session_id ?? chatId;
        const { entries } = await readTranscript(this.deps.home, this.deps.defaultProjectCwd, sessionUuid);
        return { success: true, items: projectItems(entries) };
      }

      case "get_chat_stats": {
        const chatId = params.chat_id as string;
        const chat = await this.chats.read(chatId);
        const sessionId = chat?.session_id ?? chatId;
        const stats = await readChatStats(
          this.deps.home,
          this.deps.defaultProjectCwd,
          sessionId,
          this.turns.activeTurn(chatId) !== null,
        );
        const team = await readTeamBoard(this.deps.home, sessionId);
        return { success: true, ...stats, team };
      }

      case "get_available_modes": {
        // A mode is available when its command is on disk (plain chat always is).
        const modes: ChatMode[] = [];
        for (const mode of CHAT_MODES) {
          const cmd = MODE_COMMANDS[mode];
          const file = cmd && labweaverPath(this.deps.home, "commands", `${cmd}.md`);
          if (!file || await fs.stat(file).then(() => true, () => false)) modes.push(mode);
        }
        return { success: true, modes };
      }

      case "set_chat_mode": {
        const chatId = (params.chat_id as string)?.trim();
        const mode = params.mode as ChatMode;
        if (!chatId) throw new Error("chat_id required");
        if (!CHAT_MODES.includes(mode)) throw new Error(`mode must be one of ${CHAT_MODES.join(", ")}`);
        await this.chats.setMode(chatId, mode);
        return { success: true, mode };
      }

      case "get_harness_progress": {
        // Resolution order — first hit wins, no cross-session fallback:
        //   1. chat_id → chats.project_dir            (explicit, persisted binding)
        //   2. chat_id → local_projects/<chat.name>/  (legacy: drop-created
        //      chats from before the project_dir column existed still have
        //      name === dir, so we read by name. If found, persist as
        //      project_dir so the next call hits path #1.)
        //   3. chat_id → scan message history for local_projects/<slug>/
        //      mentions. Catches typed-prompt chats whose name doesn't
        //      match the bootstrap-picked slug (e.g. chat "Run PBMC3k…"
        //      bound implicitly to local_projects/pbmc-smoke/). Persists
        //      the inferred binding too.
        //   4. project_name param → local_projects/<name>/  (manual override
        //      from the UI, e.g. before a chat is selected).
        //
        // We deliberately removed the old "most-recently-modified within 6h"
        // global fallback. It let chat A see chat B's plan whenever B's run
        // was the most recent activity in the workspace — the exact
        // cross-session leak the user wanted gone.
        const projectsRoot = path.join(this.deps.workspaceRoot, "local_projects");

        const tryPath = async (p: string): Promise<string | null> => {
          try { return await fs.readFile(p, "utf8"); }
          catch { return null; }
        };

        // A project binding follows the write rule (workspace-path.ts):
        // no traversal, no harness or secret dirs.
        const projectAbs = (rel: string): string | null => {
          try { return workspacePath(this.deps.workspaceRoot, rel, "write"); }
          catch { return null; }
        };

        const chatIdParam = (params.chat_id as string | undefined)?.trim();
        const projectNameParam = (params.project_name as string | undefined)?.trim();

        let raw: string | null = null;
        let matchedDir: string | null = null;     // workspace-relative
        let matchedDisplay: string | null = null; // last path segment for the UI

        // Path #1: explicit binding.
        let chatRow = chatIdParam ? await this.chats.read(chatIdParam) : null;
        if (chatRow?.project_dir) {
          const abs = projectAbs(chatRow.project_dir);
          if (abs) {
            raw = await tryPath(path.join(abs, "progress.md"));
            if (raw != null) {
              matchedDir = chatRow.project_dir;
              matchedDisplay = path.basename(chatRow.project_dir);
            }
          }
        }

        // Path #2: legacy name-match for chats with no explicit binding.
        // Once found, persist so the agent's cwd picks it up too.
        if (raw == null && chatRow && !chatRow.project_dir) {
          const name = chatRow.name?.trim();
          if (name && !name.includes("/") && !name.startsWith(".") && name !== "New chat") {
            const rel = `local_projects/${name}`;
            const abs = projectAbs(rel);
            if (abs) {
              raw = await tryPath(path.join(abs, "progress.md"));
              if (raw != null) {
                matchedDir = rel;
                matchedDisplay = name;
                // Fire-and-forget: backfill the binding so subsequent calls
                // (and the chat turn) use the explicit path.
                this.chats.setProjectDir(chatRow.chat_id, rel).catch((e) => {
                  console.warn(`[rpc] backfill project_dir for ${chatRow!.chat_id}:`, e);
                });
              }
            }
          }
        }

        // Path #3: history-scan inference. The agent (especially
        // tick-bootstrap) routinely echoes the absolute project path back
        // to the user — "Created project at /workspace/local_projects/foo".
        // For chats with no explicit binding and no name match, count
        // local_projects/<slug>/ mentions across the session JSONL and
        // bind to the most-mentioned slug whose progress.md exists.
        //
        // The scan is expensive (file read + regex over all messages) but
        // only runs ONCE per chat — once we persist via setProjectDir,
        // path #1 catches it forever after. We cap at 500 messages so a
        // pathologically long chat doesn't tie up the RPC thread.
        if (raw == null && chatRow && !chatRow.project_dir) {
          const inferred = await inferProjectDirFromHistory(
            this.deps.home,
            this.deps.defaultProjectCwd,
            this.deps.workspaceRoot,
            chatRow.session_id ?? chatRow.chat_id,
          );
          if (inferred) {
            raw = await tryPath(path.join(projectsRoot, inferred, "progress.md"));
            if (raw != null) {
              matchedDir = `local_projects/${inferred}`;
              matchedDisplay = inferred;
              this.chats.setProjectDir(chatRow.chat_id, matchedDir).catch((e) => {
                console.warn(`[rpc] backfill (history-inferred) project_dir for ${chatRow!.chat_id}:`, e);
              });
            }
          }
        }

        // Path #4: manual project_name (no chat context, e.g. a future
        // "browse plans" view). Pure name lookup, no binding side-effects.
        if (raw == null && projectNameParam &&
            !projectNameParam.includes("/") && !projectNameParam.startsWith(".")) {
          const rel = `local_projects/${projectNameParam}`;
          const abs = projectAbs(rel);
          if (abs) {
            raw = await tryPath(path.join(abs, "progress.md"));
            if (raw != null) {
              matchedDir = rel;
              matchedDisplay = projectNameParam;
            }
          }
        }

        if (raw == null) {
          return { success: true, exists: false, progress: null, project_name: null, project_dir: null };
        }
        return {
          success: true,
          exists: true,
          progress: parseProgressMd(raw),
          project_name: matchedDisplay,
          project_dir: matchedDir,
        };
      }

      case "set_chat_project_dir": {
        // Workspace-relative path or empty string to unbind. Validated here
        // so a malformed value never reaches the DB or the agent's cwd.
        const chatId = (params.chat_id as string)?.trim();
        if (!chatId) throw new Error("chat_id required");
        const projectDir = this.projectDirParam(params.project_dir);
        await this.chats.setProjectDir(chatId, projectDir);
        return { success: true, project_dir: projectDir };
      }

      case "stop_chat": {
        const chatId = params.chat_id as string;
        const stopped = this.turns.stop(chatId);
        return { success: true, stopped };
      }

      case "chat": {
        const chatId = params.chat_id as string;
        const messageArr = params.message as Array<{ role: string; content: string }>;
        // Acknowledged once the turn is accepted; its end arrives on the
        // stream as chat_finished, so long Auto runs outlive any RPC timeout.
        await this.turns.start(chatId, extractPrompt(messageArr));
        return { success: true };
      }

      case "proxy_toolset": {
        const methodName = params.method_name as string;
        const toolsetName = params.toolset_name as string | undefined;
        const args = (params.args as Record<string, unknown>) ?? {};
        if (toolsetName === "file_manager" || !toolsetName) {
          return this.files.dispatch(methodName, args);
        }
        if (toolsetName === "notebook") {
          return this.notebooks.dispatch(methodName, args);
        }
        throw new Error(`unknown toolset: ${toolsetName}`);
      }

      case "share_submit": {
        if (!this.deps.share) throw new Error("share api not configured");
        const res = await this.deps.share.submit(
          params as Parameters<ShareRpcClient["submit"]>[0],
        );
        return { success: true, ...(res as object) };
      }

      case "share_list": {
        if (!this.deps.share) throw new Error("share api not configured");
        const res = await this.deps.share.list(
          params as Parameters<ShareRpcClient["list"]>[0],
        );
        return { success: true, ...(res as object) };
      }

      case "share_get": {
        if (!this.deps.share) throw new Error("share api not configured");
        const res = await this.deps.share.get(params.share_id as string);
        return { success: true, share: res };
      }

      case "share_decide": {
        if (!this.deps.share) throw new Error("share api not configured");
        const { share_id, ...body } = params as { share_id: string; decision: "approve" | "reject"; comment?: string };
        const res = await this.deps.share.decide(share_id, body);
        return { success: true, ...(res as object) };
      }

      case "share_withdraw": {
        if (!this.deps.share) throw new Error("share api not configured");
        const res = await this.deps.share.withdraw(params.share_id as string);
        return { success: true, ...(res as object) };
      }

      case "share_capabilities": {
        if (!this.deps.share) throw new Error("share api not configured");
        const res = await this.deps.share.capabilities();
        return { success: true, ...(res as object) };
      }

      case "skills_list": {
        const skills = await listUserSkills(this.deps.home);
        return { success: true, skills };
      }

      case "skill_get_manifest": {
        const name = params.name as string;
        const manifest = await readUserSkillManifest(this.deps.home, name);
        return { success: true, manifest };
      }

      case "org_skills_list": {
        const skills = await listOrgSkills(this.deps.workspaceRoot);
        return { success: true, skills };
      }

      case "commands_list": {
        const commands = await listUserCommands(this.deps.home);
        return { success: true, commands };
      }

      case "dsh_client_modules": {
        const modules = await listClientModules(acpProfileDir(this.deps.home));
        return { success: true, modules };
      }

      case "h5ad_introspect": {
        const p = params.path as string;
        if (!p || typeof p !== "string") throw new Error("path required");
        const res = await this.h5ad.introspect(p);
        return { success: true, ...res };
      }

      case "h5ad_plot": {
        const p = params.path as string;
        const kind = params.kind as "qc" | "embedding" | "spatial";
        if (!p || typeof p !== "string") throw new Error("path required");
        if (!kind) throw new Error("kind required");
        const plotParams = (params.params as Record<string, unknown>) ?? {};
        const res = await this.h5ad.plot(p, kind, plotParams);
        return { success: true, ...res };
      }

      case "chpc_bridge_status": {
        const status = await this.chpc.status();
        return { success: true, status };
      }

      case "chpc_bridge_open": {
        const password = params.password as string | undefined;
        const duo = params.duo as OpenRequest["duo"] | undefined;
        const requestId = params.requestId as string | undefined;
        if (!password || typeof password !== "string") throw new Error("password required");
        if (!requestId || typeof requestId !== "string") throw new Error("requestId required");
        if (!duo || (duo.kind !== "push" && duo.kind !== "passcode")) {
          throw new Error("duo.kind must be 'push' or 'passcode'");
        }
        if (duo.kind === "passcode" && (!duo.code || typeof duo.code !== "string")) {
          throw new Error("duo.code required when duo.kind === 'passcode'");
        }
        // Fire-and-forget — open() returns immediately, status arrives via stream.
        const res = await this.chpc.open({ password, duo, requestId });
        return { success: true, ...res };
      }

      case "chpc_bridge_close": {
        const res = await this.chpc.close();
        return { success: true, ...res };
      }

      case "get_role":
        return { success: true, manager: !!this.deps.fleet };

      case "fleet_status": {
        if (!this.deps.fleet) throw new Error("fleet_status is only available in the manager container");
        return { success: true, containers: await this.deps.fleet.list() };
      }

      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  /** Validate a workspace-relative project dir param; "" or absent → null.
   *  The dir needn't exist yet — drop-to-project binds right after
   *  createDirectory, racing it across NATS. The binding is just a pointer. */
  private projectDirParam(value: unknown): string | null {
    const raw = typeof value === "string" ? value.trim() : "";
    if (raw === "") return null;
    workspacePath(this.deps.workspaceRoot, raw, "write"); // throws on traversal, harness or secret dirs
    return raw.replace(/\/+$/, "");
  }
}

// Allow-listed parent for any image path the frontend can attach. The frontend
// can only POST uploads into this directory via the upload-http server, so any
// path outside it is either a programming error or someone trying to read
// CLAUDE.md / .env via a crafted [image:] line.
const ATTACHMENT_PREFIX = "/workspace/local_projects/.chat-attachments/";

const MEDIA_TYPE_BY_EXT: Record<string, ImageRef["mediaType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// ─── progress.md parsing ───────────────────────────────────────────────
// The tick harness keeps all per-project state in a single markdown file. The
// frontend wants a parsed view for its self-driving checklist, but we don't
// want a full markdown library here — the structure is rigid enough that line
// scanning is sufficient. Tolerant on input: if a section is missing or the
// format drifts, we degrade to "no steps" rather than throwing.

export interface ProgressStep {
  /** First word after the box (and the optional `(reviewed)` marker). */
  name: string;
  /** Rest of the line up to ` | ` (which separates description from metrics). */
  description: string;
  done: boolean;
  reviewed: boolean;
}

export interface ParsedProgress {
  pipeline: string | null;
  steps: ProgressStep[];
  complete: boolean;
  /** Count of unchecked `☐` lines under `## Review feedback`. */
  pendingFeedback: number;
  /** Index of the next ☐ step (or null when nothing is pending). The
   *  orchestrator dispatches this one next, so the UI can highlight it. */
  nextStepIndex: number | null;
}

const STEP_LINE_RE = /^-\s*([☑☐])\s*(?:\(reviewed\)\s*)?(\S+)(?:\s+(.*))?$/u;

// Match a local_projects/<slug> reference in message content. Slug rules
// mirror tick-bootstrap's slugifier (lowercase kebab + dataset accessions)
// plus a defensive cap on length so we don't capture pathological junk.
// We tolerate optional /workspace/ prefix and either / or end-of-token
// terminator so "local_projects/foo," and "local_projects/foo/data/x.h5"
// both yield "foo".
const PROJECT_REF_RE = /(?:^|[\s"'`])(?:\/workspace\/)?local_projects\/([a-z0-9][a-z0-9._-]{0,63})(?=[\s/"'`,)\]]|$)/giu;

/**
 * Scan a chat's session history for `local_projects/<slug>/` mentions and
 * return the slug that (a) appears most often and (b) has an existing
 * progress.md. Returns null if nothing matches. Caps at 500 messages.
 *
 * Used as a one-shot inference for chats with no DB binding and no
 * chat-name match — the result is persisted so the scan only runs once.
 */
async function inferProjectDirFromHistory(
  home: string,
  cwd: string,
  workspaceRoot: string,
  sessionId: string,
): Promise<string | null> {
  let items: ChatItem[] = [];
  try {
    items = projectItems((await readTranscript(home, cwd, sessionId)).entries);
  } catch {
    return null;
  }
  if (items.length === 0) return null;
  // Walk newest-to-oldest so we early-exit on the first viable hit, which
  // is typically the most recent agent/user reference to the project.
  const counts = new Map<string, number>();
  const considered = items.slice(-500);
  for (const it of considered) {
    const content = (it.kind === "tool" ? it.output : it.text) ?? "";
    if (!content) continue;
    PROJECT_REF_RE.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = PROJECT_REF_RE.exec(content)) != null) {
      const slug = mm[1];
      // mm[1] is technically string|undefined under strict TS; the regex
      // always has the capture group, but humour the type system.
      if (!slug) continue;
      // Skip dotted/underscored special dirs (.chat-attachments, _starter_pipelines).
      if (slug.startsWith(".") || slug.startsWith("_")) continue;
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;

  // Tie-break: the slug with the most mentions whose progress.md exists.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [slug] of ranked) {
    const candidate = path.join(workspaceRoot, "local_projects", slug, "progress.md");
    const ok = await fs.stat(candidate).then((s) => s.isFile()).catch(() => false);
    if (ok) return slug;
  }
  return null;
}

export function parseProgressMd(raw: string): ParsedProgress {
  // Walk the file once, tracking which top-level section we're in. Plan and
  // Review feedback are the only sections with parseable structure.
  let section: string | null = null;
  let pipeline: string | null = null;
  const steps: ProgressStep[] = [];
  let pendingFeedback = 0;
  let complete = false;

  for (const line of raw.split(/\r?\n/)) {
    const headerMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (headerMatch) {
      const heading = (headerMatch[1] ?? "").toLowerCase();
      if (heading.startsWith("status:")) {
        if (/complete/i.test(line)) complete = true;
        section = null;
        continue;
      }
      // First word: plan / sample(s) / pipeline / review / ...
      section = heading.split(/\s+/)[0] ?? null;
      continue;
    }

    if (section === "pipeline" && line.trim() && !pipeline) {
      pipeline = line.trim();
      continue;
    }

    if (section === "plan") {
      const m = STEP_LINE_RE.exec(line);
      if (!m) continue;
      const box = m[1] ?? "";
      const name = m[2] ?? "";
      const restRaw = (m[3] ?? "").trim();
      // Strip metrics suffix (` | metric=value ...`) from the human-readable
      // description so the checklist stays one line.
      const description = (restRaw.split(/\s*\|\s*/, 1)[0] ?? "").trim();
      steps.push({
        name,
        description,
        done: box === "☑",
        reviewed: /\(reviewed\)/.test(line),
      });
    }

    if (section === "review" && /^-\s*☐/.test(line)) {
      pendingFeedback++;
    }
  }

  const nextStepIndex = steps.findIndex(s => !s.done);
  return {
    pipeline,
    steps,
    complete,
    pendingFeedback,
    nextStepIndex: nextStepIndex === -1 ? null : nextStepIndex,
  };
}

const IMAGE_LINE_RE = /^\[image:\s*([^\]]+)\]\s*$/;

/**
 * Pull the most recent user message and split out any `[image: <path>]`
 * lines into structured ImageRefs. Lines for non-allow-listed paths are
 * dropped (logged); the rest of the text passes through verbatim.
 */
function extractPrompt(messages: Array<{ role: string; content: string }>): {
  text: string;
  images: ImageRef[];
} {
  let raw = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") { raw = m.content; break; }
  }
  if (!raw) return { text: "", images: [] };

  const images: ImageRef[] = [];
  const remaining: string[] = [];
  for (const line of raw.split("\n")) {
    const m = IMAGE_LINE_RE.exec(line);
    if (!m || !m[1]) { remaining.push(line); continue; }
    const path = m[1].trim();
    if (!path.startsWith(ATTACHMENT_PREFIX)) {
      console.warn(`[chat] dropping image line outside allowed prefix: ${path}`);
      continue;
    }
    const ext = (path.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();
    const mediaType = MEDIA_TYPE_BY_EXT[ext];
    if (!mediaType) {
      console.warn(`[chat] dropping image with unsupported extension: ${path}`);
      continue;
    }
    images.push({ path, mediaType });
  }
  return { text: remaining.join("\n").trim(), images };
}
