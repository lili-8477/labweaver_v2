// LabWeaver Frontend Types — MIT License

export * from './memory'

// ============================================================
// NATS / Connection
// ============================================================

export interface NATSMessage {
  method: string
  parameters: Record<string, unknown>
  correlation_id?: string
}

export interface NATSResponse {
  result?: unknown
  error?: string
}

export interface ConnectionConfig {
  url: string
  serviceId: string
  subjectPrefix?: string
  token?: string
}

// ============================================================
// Tick-harness progress (parsed from progress.md by the adapter)
// ============================================================

export interface HarnessStep {
  name: string
  description: string
  done: boolean
  reviewed: boolean
}

export interface HarnessProgress {
  pipeline: string | null
  steps: HarnessStep[]
  complete: boolean
  pendingFeedback: number
  /** Index of the next ☐ step; null when nothing is pending. */
  nextStepIndex: number | null
}

// ============================================================
// Chat
// ============================================================

/** How a chat runs its turns: plain agent, the self-driving tick harness, or an agent team. */
export type ChatMode = 'chat' | 'auto' | 'team'

export interface ChatInfo {
  id: string
  name: string
  last_activity_date?: string
  running?: boolean
  /** The running turn is an Auto-mode run (the chat's own mode is back to chat). */
  auto_running?: boolean
  project_name?: string
  /** Workspace-relative project directory bound to this chat (e.g.
   *  "local_projects/foo-1a2b"). When set, the agent cd's here and harness
   *  progress is read from <project_dir>/progress.md. Null = unbound. */
  project_dir?: string | null
  mode?: ChatMode
  /** Set when this chat is a sub-session branched from another chat. */
  parent_chat_id?: string | null
}

/** A project folder under local_projects/; chats bind to it via project_dir. */
export interface ProjectInfo {
  dir: string
  name: string
  modified_at: string
}

/** What the chat view shows, in the agent's order (adapter/src/chat-items.ts).
 *  get_chat_items returns them; a live turn streams each one it adds or
 *  changes, and the store upserts by id. */
export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; text: string }
  | ToolItem

export interface ToolItem {
  kind: 'tool'
  id: string
  name: string
  input: unknown
  /** Absent until the result arrives. */
  output?: string
  isError?: boolean
  /** ISO timestamps of the call and of its result. */
  startedAt: string
  endedAt?: string
}

export interface ItemEvent {
  type: 'item'
  chat_id: string
  item: ChatItem
}

export interface ChatFinished {
  type: 'chat_finished'
  chat_id: string
  status: 'done' | 'stopped' | 'error'
  error?: string
}

export type StreamData = ItemEvent | ChatFinished

export interface StreamMessage {
  type: 'chat' | 'notebook' | 'custom'
  session_id: string
  timestamp: number
  data: StreamData
  metadata?: Record<string, unknown>
}

// ============================================================
// Agents panel: token usage and subagent runs (get_chat_stats)
// ============================================================

export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface SubagentRun {
  sessionId: string
  description: string | null
  status: 'running' | 'done' | 'failed' | 'stopped'
  model: string | null
  startedAt: string
  endedAt: string
  tokens: TokenTotals
  toolCalls: number
  result: string | null
}

export interface ChatStats {
  main: TokenTotals
  turns: number
  lastTurn: TokenTotals | null
  subagents: SubagentRun[]
  /** The chat's Agent Team; null until the lead creates a teammate or task. */
  team: TeamBoard | null
}

export interface TeamMember {
  /** Session id; a teammate's matches its subagent run's sessionId. */
  id: string
  name: string
  role: 'lead' | 'teammate'
  status: 'running' | 'inactive' | 'provisioning' | 'failed'
  description?: string
  model?: string
}

export interface TeamTask {
  id: string
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed'
  ownerName?: string
  blockedBy: string[]
  ready: boolean
}

export interface TeamBoard {
  members: TeamMember[]
  tasks: TeamTask[]
  updatedAt: number
}

// ============================================================
// File System
// ============================================================

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modified?: number
  children?: FileEntry[]
}

// ============================================================
// Notebook
// ============================================================

export interface NotebookCell {
  id: string
  cell_type: 'code' | 'markdown' | 'raw'
  source: string
  outputs: CellOutput[]
  execution_count: number | null
  metadata: Record<string, unknown>
}

export interface CellOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error'
  name?: string     // stdout, stderr
  text?: string | string[]
  data?: Record<string, unknown>  // mime-type -> content
  metadata?: Record<string, unknown>
  ename?: string
  evalue?: string
  traceback?: string[]
  execution_count?: number
}

export interface Notebook {
  cells: NotebookCell[]
  metadata: Record<string, unknown>
  nbformat: number
  nbformat_minor: number
}

export interface NotebookInfo {
  file_path: string
  version: number
  cell_count: number
  notebook: Notebook
}

export interface VariableInfo {
  name: string
  type: string
  size?: string
  value?: string
}

/** Kernel lifecycle status */
export type KernelStatus = 'idle' | 'busy' | 'starting' | 'dead' | 'unknown'

/** Per-cell UI mode (Jupyter-style) */
export type CellMode = 'command' | 'edit'

/** Markdown cell display mode */
export type MarkdownMode = 'rendered' | 'editing'

/** Clipboard entry for copy/cut/paste cell operations */
export interface ClipboardCell {
  cell_type: 'code' | 'markdown' | 'raw'
  source: string
  metadata?: Record<string, unknown>
}

/** Snapshot for undo/redo stack */
export interface NotebookSnapshot {
  cells: NotebookCell[]
  timestamp: number
  action: string
}

// ============================================================
// Notebook IOPub streaming
// ============================================================

export interface NotebookStreamMessage {
  type: 'notebook'
  session_id: string
  timestamp: number
  data: {
    msg_type: string
    content: Record<string, unknown>
    header?: Record<string, unknown>
    metadata?: Record<string, unknown>
    parent_header?: Record<string, unknown>
  }
  metadata?: {
    source?: string
    cell_id?: string
    notebook_path?: string
    operated_by?: string
  }
}
