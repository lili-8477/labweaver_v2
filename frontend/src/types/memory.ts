// LabWeaver Memory Types — MIT License

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'session_summary' | 'observation'
export type MemorySource = 'user' | 'distilled'
export type ScopeTier = 'org' | 'user' | 'project'

export interface MemoryListItem {
  memory_id: string
  type: MemoryType
  source: MemorySource
  scope_tier: ScopeTier
  dir_key: string            // e.g. "project/decisions"; prefix is the scope
  name: string
  description: string
  created_at: string
  updated_at: string
  hit_count: number
  last_hit_at: string | null
  deleted_at: string | null
}

export interface MemoryDetail extends MemoryListItem {
  body: string
  facets: Record<string, string[]>
  source_session_id: string | null
}

export interface MemoryAuditEntry {
  audit_id: number
  action: 'write' | 'update' | 'forget' | 'restore'
  actor: string
  before: unknown
  after: unknown
  created_at: string
}

// Search hit with snippet and relevance score
export interface MemorySearchHit extends MemoryListItem {
  snippet: string
  score: number
}

// A memory directory with its one-line summary (L0) and live entry count
export interface MemoryDirSummary {
  dir_key: string            // e.g. "project/decisions"
  scope: ScopeTier
  l0: string
  entry_count: number
  updated_at: string | null
}

// Memory tree (GET /memory/tree): every live memory with usage counters, and
// facet topics ranked by how ready they are to become a skill.
export interface MemoryTreeLeaf {
  memory_id: string
  name: string
  description: string
  dir_key: string
  scope: ScopeTier
  project_dir: string | null
  created_at: string
  updated_at: string
  hit_count: number
  success_count: number
  failure_count: number
  topics: string[]           // "pipeline:toy-stats", "tool:pandas", …
}

export interface MemoryTopic {
  topic: string
  key: string
  value: string
  memory_ids: string[]
  dirs: string[]
  memory_count: number
  hit_count: number
  success_count: number
  failure_count: number
  readiness: number          // 0..1
  ready: boolean
}

export interface MemoryTree {
  dirs: MemoryDirSummary[]
  memories: MemoryTreeLeaf[]
  topics: MemoryTopic[]
  thresholds: { memories: number; successes: number }
}
