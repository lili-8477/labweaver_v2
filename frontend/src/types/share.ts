// frontend/src/types/share.ts
export type { ArtifactKind, ShareStatus, ShareRequest, ShareCapabilities } from '@rpc-contract'

// Phase 2: skill snapshot shape inside snapshot_meta when artifact_kind='skill'.
export interface SkillSnapshotFile {
  path:       string;     // POSIX-style, relative to the skill dir
  sha256:     string;
  size_bytes: number;
}

export interface SkillSnapshotMeta {
  root_name: string;                 // basename of the skill folder
  manifest:  string;                 // SKILL.md contents
  files:     SkillSnapshotFile[];
}

// Phase 3: folder snapshot shape inside snapshot_meta when artifact_kind='folder'.
export interface FolderSnapshotMeta {
  root_name:   string;
  readme:      string | null;
  files:       SkillSnapshotFile[];      // reuse — same {path, sha256, size_bytes}
  total_bytes: number;
}
