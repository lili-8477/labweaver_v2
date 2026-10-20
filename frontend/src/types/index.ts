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
// Wire types: what the adapter's RPCs take and return (the RPC contract,
// adapter/src/rpc-contract.ts). Frontend-only types follow below.
// ============================================================

export type {
  ChatMode, ChatInfo, ProjectInfo, ChatItem, ToolItem, HarnessProgress, HarnessStep,
  TokenTotals, SubagentRun, ChatStats, TeamMember, TeamTask, TeamBoard,
  CellOutput, CellType, Notebook, NotebookCell, NotebookInfo, KernelReply,
} from '@rpc-contract'
import type { ChatItem, NotebookCell } from '@rpc-contract'

// ============================================================
// Chat
// ============================================================

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
