// The RPC contract (GLOSSARY.md): every method the frontend calls on its
// adapter over NATS, with its params and its result, in one table. The
// adapter's router is typed against RpcMethods (rpc.ts), the file-manager and
// notebook toolsets against FileManagerMethods and NotebookMethods, and the
// frontend's natsService.invoke / callToolset take their types from here, so
// the compiler holds both sides of the wire to the same shapes. The memory_*
// UI ops come from the memory contract.
//
// Types only: the frontend imports this file (tsconfig path @rpc-contract),
// so it must not pull in anything that needs Node.

import type { MemoryInput, MemoryResult, UiOp } from "../../hub/indexer/src/memory-contract.js";
import type { ParsedProgress, ProgressStep } from "../dsh-plugins/progress.js";

type Ok<T = unknown> = { success: true } & T;
type NoParams = Record<string, never>;

// ─── chats ──────────────────────────────────────────────────────────────

/** How a chat runs its turns: plain agent, the self-driving tick harness, or an agent team. */
export type ChatMode = "chat" | "auto" | "team";

export interface ChatInfo {
  id: string;
  name: string;
  last_activity_date: string;
  project_name: string;
  /** Workspace-relative project dir (e.g. "local_projects/foo-1a2b") or null.
   *  When set, the agent cd's here and harness progress is read from it. */
  project_dir: string | null;
  mode: ChatMode;
  active_agent: string | null;
  /** Set when this chat is a sub-session branched from another chat. */
  parent_chat_id: string | null;
  /** A turn is running. */
  running: boolean;
  /** The running turn is an Auto-mode run (the chat's own mode is back to chat). */
  auto_running: boolean;
}

/** A project folder under local_projects/; chats bind to it via project_dir. */
export interface ProjectInfo {
  /** Workspace-relative, e.g. "local_projects/pbmc-qc". */
  dir: string;
  name: string;
  modified_at: string;
}

/** What the chat view shows, in the agent's order (chat-items.ts). */
export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "text"; id: string; text: string }
  | ToolItem;

export interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  input: unknown;
  /** Absent until the result arrives; capped at MAX_TOOL_OUTPUT_CHARS. */
  output?: string;
  isError?: boolean;
  /** ISO timestamps of the call and of its result. */
  startedAt: string;
  endedAt?: string;
}

/** The plan in a project's progress.md, as the UI shows it (dsh-plugins/progress.js). */
export type HarnessProgress = ParsedProgress;
export type HarnessStep = ProgressStep;

// ─── agents panel (get_chat_stats) ──────────────────────────────────────

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SubagentRun {
  sessionId: string;
  description: string | null;
  /** "stopped": no result and the chat's turn is no longer running. */
  status: "running" | "done" | "failed" | "stopped";
  model: string | null;
  startedAt: string;
  endedAt: string;
  tokens: TokenTotals;
  toolCalls: number;
  /** First line of the run's last reply. */
  result: string | null;
}

/** Token use read from the chat's transcripts (chat-stats.ts). */
export interface TranscriptStats {
  /** The chat's own turns, every session in its continuation chain. */
  main: TokenTotals;
  turns: number;
  lastTurn: TokenTotals | null;
  subagents: SubagentRun[];
}

export interface ChatStats extends TranscriptStats {
  /** The chat's Agent Team; null until the lead creates a teammate or task. */
  team: TeamBoard | null;
}

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

// ─── models, skills, commands, client plugins ───────────────────────────

export interface ModelOption {
  /** "provider/model". */
  ref: string;
  label: string;
  provider: string;
  available: boolean;
}

export interface SkillSummary {
  name: string;
  /** Empty string when the frontmatter has no description. */
  description: string;
}

export interface CommandSummary {
  name: string;
  /** Empty string when the frontmatter has no description. */
  description: string;
}

export interface ClientModule {
  /** Package name, e.g. "@skillre/dsh-plugin-pomodoro". */
  id: string;
  /** The bundle source: one `window.__ModuleLoader__.load(...)` call. */
  code: string;
}

// ─── share requests (hub share-api, forwarded) ──────────────────────────

export type ArtifactKind = "memory" | "skill" | "folder" | "skill_update";
export type ShareStatus = "pending" | "approved" | "rejected" | "withdrawn" | "auto_rejected";

export interface ShareRequest {
  share_id: string;
  artifact_kind: ArtifactKind;
  artifact_ref: string;
  /** Shape varies by kind (memory: name, description, body, type, …). */
  snapshot_meta: Record<string, unknown>;
  requester: string;
  reviewer: string;
  status: ShareStatus;
  requester_note: string | null;
  review_comment: string | null;
  promotion_result: Record<string, unknown> | null;
  /** ISO. */
  created_at: string;
  decided_at: string | null;
}

export interface ShareCapabilities {
  is_manager: boolean;
  manager_usernames: string[];
  pending_inbox_count: number;
  actor_username: string;
}

// ─── h5ad viewer ────────────────────────────────────────────────────────

export interface ObsColumn {
  name: string;
  dtype: string;
  n_categories?: number;
  categories?: string[];
  min?: number;
  max?: number;
}

export interface SpatialInfo {
  library_ids: Array<{ library_id: string; images?: string[] }>;
  has_coords: boolean;
}

export interface H5adIntrospection {
  shape: [number, number];
  obs_cols: ObsColumn[];
  var_names: string[];
  var_count: number;
  obsm_keys: string[];
  embeddings: string[];
  spatial: SpatialInfo | null;
  qc: {
    has_total_counts: boolean;
    has_n_genes_by_counts: boolean;
    has_pct_counts_mt: boolean;
  };
  layers: string[];
}

export type PlotKind = "qc" | "embedding" | "spatial";

// ─── CHPC bridge ────────────────────────────────────────────────────────

export type BridgeStatus =
  | { kind: "up"; pid: number; openedAt: string; user: string }
  | { kind: "down" }
  | { kind: "unprovisioned"; reason: "no-ssh" | "no-config" };

export type DuoChoice = { kind: "push" } | { kind: "passcode"; code: string };

export interface OpenRequest {
  password: string;
  duo: DuoChoice;
  requestId: string;
}

/** Phase updates of an open, on the `chpc_bridge_events` stream. */
export type OpenEvent =
  | { requestId: string; phase: "spawned" }
  | { requestId: string; phase: "password-accepted" }
  | { requestId: string; phase: "duo-waiting" }
  | { requestId: string; phase: "up"; pid: number }
  | {
      requestId: string;
      phase: "error";
      code: "bad-password" | "duo-denied" | "duo-timeout" | "network" | "config" | "unknown";
      message: string;
    };

// ─── fleet (manager container) ──────────────────────────────────────────

export interface ContainerStatus {
  username: string;
  role: "manager" | "user";
  hostname: string;
  startedAt: number;
  reportedAt: number;
  memoryBytes: number;
  memoryLimitBytes: number | null;
  /** Percent of one core since the previous report; null on the first. */
  cpuPercent: number | null;
  cpus: number;
  activeTurns: number;
  kernels: number;
}

export interface FleetEntry {
  username: string;
  online: boolean;
  status: ContainerStatus | null;
}

// ─── the flat methods ───────────────────────────────────────────────────

export type ToolsetName = "file_manager" | "notebook";

export interface Toolsets {
  file_manager: FileManagerMethods;
  notebook: NotebookMethods;
}

/** proxy_toolset's params: one toolset method and its args. */
export type ToolsetCall = {
  [T in ToolsetName]: {
    [M in keyof Toolsets[T]]: { toolset_name: T; method_name: M; args: Toolsets[T][M] extends { params: infer P } ? P : never };
  }[keyof Toolsets[T]];
}[ToolsetName];

type MemoryMethods = { [O in UiOp]: { params: MemoryInput<O>; result: MemoryResult<O> } };

export interface RpcMethods extends MemoryMethods {
  get_endpoint:        { params: NoParams; result: Ok<{ service_id: string }> };
  get_role:            { params: NoParams; result: Ok<{ manager: boolean }> };
  fleet_status:        { params: NoParams; result: Ok<{ containers: FleetEntry[] }> };

  get_model:           { params: NoParams; result: Ok<{ model: string }> };
  list_models:         { params: NoParams; result: Ok<{ models: ModelOption[] }> };
  set_model:           { params: { model: string }; result: Ok<{ model: string }> };

  list_chats:          { params: NoParams; result: Ok<{ chats: ChatInfo[] }> };
  create_chat: {
    params: { chat_name?: string; parent_chat_id?: string; project_dir?: string | null };
    result: Ok<{ chat_id: string }>;
  };
  delete_chat:         { params: { chat_id: string }; result: Ok };
  update_chat_name:    { params: { chat_id: string; chat_name: string }; result: Ok };
  get_chat_items:      { params: { chat_id: string }; result: Ok<{ items: ChatItem[] }> };
  get_chat_stats:      { params: { chat_id: string }; result: Ok<ChatStats> };
  get_available_modes: { params: NoParams; result: Ok<{ modes: ChatMode[] }> };
  set_chat_mode:       { params: { chat_id: string; mode: ChatMode }; result: Ok<{ mode: ChatMode }> };
  set_chat_project_dir: {
    /** Workspace-relative path; "" or null unbinds. */
    params: { chat_id: string; project_dir: string | null };
    result: Ok<{ project_dir: string | null }>;
  };
  /** Starts a turn; its end arrives on the chat stream as chat_finished. */
  chat:                { params: { chat_id: string; message: Array<{ role: string; content: string }> }; result: Ok };
  stop_chat:           { params: { chat_id: string }; result: Ok<{ stopped: boolean }> };

  list_projects:       { params: NoParams; result: Ok<{ projects: ProjectInfo[] }> };
  create_project:      { params: { name: string }; result: Ok<{ project: ProjectInfo }> };
  get_harness_progress: {
    /** project_name is a last-resort hint for chats with no binding yet. */
    params: { chat_id?: string; project_name?: string };
    result: Ok<
      | { exists: false; progress: null; project_name: null; project_dir: null }
      | { exists: true; progress: HarnessProgress; project_name: string | null; project_dir: string | null }
    >;
  };

  /** One file-manager or notebook method; prefer the frontend's callToolset, which types it per method. */
  proxy_toolset:       { params: ToolsetCall; result: unknown };

  share_submit: {
    params: { kind: ArtifactKind; ref: string; note?: string };
    result: Ok<{ share_id: string }>;
  };
  share_list: {
    params: { role: "outbox" | "inbox" | "all"; status?: ShareStatus; limit?: number; cursor?: string };
    result: Ok<{ items: ShareRequest[]; next_cursor: string | null }>;
  };
  share_get:           { params: { share_id: string }; result: Ok<{ share: ShareRequest }> };
  share_decide: {
    params: { share_id: string; decision: "approve" | "reject"; comment?: string };
    result: Ok<{ status: ShareStatus; promotion_result?: Record<string, unknown> }>;
  };
  share_withdraw:      { params: { share_id: string }; result: Ok<{ status: ShareStatus }> };
  share_capabilities:  { params: NoParams; result: Ok<ShareCapabilities> };

  skills_list:         { params: NoParams; result: Ok<{ skills: SkillSummary[] }> };
  skill_get_manifest:  { params: { name: string }; result: Ok<{ manifest: string }> };
  org_skills_list:     { params: NoParams; result: Ok<{ skills: SkillSummary[] }> };
  commands_list:       { params: NoParams; result: Ok<{ commands: CommandSummary[] }> };
  dsh_client_modules:  { params: NoParams; result: Ok<{ modules: ClientModule[] }> };

  h5ad_introspect:     { params: { path: string }; result: Ok<H5adIntrospection> };
  h5ad_plot: {
    params: { path: string; kind: PlotKind; params?: Record<string, unknown> };
    /** png: base64-encoded PNG, no data: prefix. */
    result: Ok<{ png: string }>;
  };

  chpc_bridge_status:  { params: NoParams; result: Ok<{ status: BridgeStatus }> };
  /** Returns once accepted; phases arrive on the chpc_bridge_events stream. */
  chpc_bridge_open:    { params: OpenRequest; result: Ok<{ accepted: true }> };
  chpc_bridge_close:   { params: NoParams; result: Ok<{ ok: true; wasRunning: boolean }> };
}

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M]["params"];
export type RpcResult<M extends RpcMethod> = RpcMethods[M]["result"];

// ─── file manager toolset ───────────────────────────────────────────────

export interface FileListing {
  name: string;
  /** Workspace-relative. */
  path: string;
  type: "file" | "directory";
  /** Absent for directories. */
  size?: number;
  /** Unix seconds. */
  modified: number;
}

export interface FileContent {
  content: string;
  encoding: "utf8" | "base64";
  mime_type: string;
  size: number;
}

/** Paths are workspace-relative. */
export interface FileManagerMethods {
  /** sub_dir: null or "" lists the workspace root. */
  list_files:  { params: { sub_dir: string | null }; result: Ok<{ files: FileListing[] }> };
  /** encoding: force base64 (binary extensions are always base64). */
  read_file:   { params: { file_path: string; encoding?: "utf8" | "base64" }; result: Ok<FileContent> };
  write_file:  { params: { file_path: string; content: string; encoding?: "utf8" | "base64" }; result: Ok };
  delete_file: { params: { file_path: string }; result: Ok };
  manage_path: {
    params:
      | { operation: "create_dir"; path: string }
      | { operation: "delete"; path: string; recursive?: boolean }
      | { operation: "move"; from: string; to: string };
    result: Ok;
  };
}

// ─── notebook toolset ───────────────────────────────────────────────────

export type CellType = "code" | "markdown" | "raw";

export interface CellOutput {
  output_type: "stream" | "execute_result" | "display_data" | "error";
  /** stdout, stderr. */
  name?: string;
  text?: string | string[];
  /** mime type → content. */
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  execution_count?: number;
}

export interface NotebookCell {
  id: string;
  cell_type: CellType;
  source: string;
  outputs: CellOutput[];
  execution_count: number | null;
  metadata: Record<string, unknown>;
}

export interface Notebook {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

/** A notebook after a read or an edit. */
export interface NotebookInfo {
  file_path: string;
  /** Bumped on every edit, so a client can spot staleness. */
  version: number;
  cell_count: number;
  notebook: Notebook;
  /** Present when kernels are configured: the IOPub stream is notebook_iopub_<id>. */
  kernel_session_id?: string;
}

export interface KernelVariable {
  type: string;
  repr: string;
  shape: string | null;
}

export type KernelAction = "status" | "interrupt" | "restart" | "shutdown" | "variables";

/** manage_kernel's reply; which fields are set depends on the action. */
export interface KernelReply {
  success: boolean;
  error?: string;
  kernel_session_id?: string | null;
  /** status: the kernel's state ("dead" when none is running). */
  kernel_status?: string;
  status?: string;
  running?: boolean;
  pid?: number | null;
  started_at?: number | null;
  last_activity_at?: number | null;
  idle_ms?: number | null;
  in_flight?: number;
  rss_mb?: number | null;
  /** variables: the kernel's user globals. */
  variables?: Record<string, KernelVariable>;
}

export interface ExecuteReply {
  success: boolean;
  status?: string;
  execution_count?: number | null;
  /** The kernel's error text; null when the cell ran clean. */
  error?: string | null;
  kernel_session_id?: string;
}

export interface NotebookMethods {
  read_notebook:   { params: { notebook_path: string }; result: Ok<NotebookInfo> };
  create_notebook: { params: { notebook_path: string; language?: "python" | "r" }; result: Ok<NotebookInfo> };
  /** position: null appends; a cell id inserts after it; "N" inserts at index N. */
  add_cell: {
    params: { notebook_path: string; cell_type?: CellType; content: string; position?: string | number | null };
    result: Ok<NotebookInfo & { cell_id: string }>;
  };
  update_cell:     { params: { notebook_path: string; cell_id: string; content: string }; result: Ok<NotebookInfo> };
  delete_cell:     { params: { notebook_path: string; cell_id: string }; result: Ok<NotebookInfo> };
  /** below_cell_id null or absent: move to the top. */
  move_cell:       { params: { notebook_path: string; cell_id: string; below_cell_id?: string | null }; result: Ok<NotebookInfo> };
  execute_cell:    { params: { notebook_path: string; cell_id: string }; result: ExecuteReply };
  manage_kernel:   { params: { notebook_path: string; action: KernelAction }; result: KernelReply };
}
