import * as path from "node:path";
import { LABWEAVER_DIR } from "./labweaver-dir.js";

export interface ResolvedJsonlPath {
  username: string;
  encodedProjectDir: string;
  sessionId: string;
  displayProjectPath: string;
}

/**
 * Resolve a watched JSONL path into its trust-critical components.
 *
 * Expected layout (the labweaver folder add-user.sh bind-mounts):
 *   <watchRoot>/<username>/.labweaver/projects/<encoded>/<sessionId>.jsonl
 *
 * Username is taken from the watch-root-relative path prefix — never from the
 * encoded project directory name. The decoded project path is lossy (real
 * dashes collide with separator dashes) and is only suitable for display.
 */
export function resolveJsonlPath(
  watchRoot: string,
  fullPath: string,
): ResolvedJsonlPath | null {
  const normRoot = path.resolve(watchRoot);
  const normFull = path.resolve(fullPath);
  if (!normFull.startsWith(normRoot + path.sep)) return null;

  const rel = normFull.slice(normRoot.length + 1);
  const parts = rel.split(path.sep);
  // username / .labweaver / projects / encoded / sessionId.jsonl
  if (parts.length !== 5) return null;
  if (parts.some((p) => p === "" || p === "..")) return null;
  const [username, dir, sub, encodedProjectDir, file] = parts as [
    string, string, string, string, string,
  ];
  if (dir !== LABWEAVER_DIR) return null;
  if (sub !== "projects") return null;
  if (!file.endsWith(".jsonl")) return null;
  const sessionId = file.slice(0, -".jsonl".length);
  if (sessionId.length === 0) return null;

  return {
    username,
    encodedProjectDir,
    sessionId,
    displayProjectPath: decodeDisplay(encodedProjectDir),
  };
}

function decodeDisplay(encoded: string): string {
  // Claude Code encodes "/a/b" as "-a-b". Decode by replacing every "-" with
  // "/". Known lossy when a real path contains "-".
  return encoded.replace(/-/g, "/");
}

/**
 * Encode an absolute project path into the Claude-Code-style directory name
 * used as `encoded_project_dir` (e.g. "/workspace/pbmc3k" → "-workspace-pbmc3k").
 *
 * This is the inverse of `decodeDisplay` and is intentionally lossy in the
 * other direction: a real underscore-vs-hyphen decision belongs to whatever
 * tool created the on-disk encoded name. Use this only to produce filter
 * values for queries against `memories.project_dir` / `sessions.encoded_project_dir`,
 * never to construct filesystem paths.
 *
 * Inputs are normalised to a leading "/" so callers may pass either a raw
 * absolute path or an already-leading-slash path. A trailing slash is
 * stripped so "/workspace" and "/workspace/" produce the same output.
 */
export function encodeProjectDir(projectPath: string): string {
  let p = projectPath;
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p.replace(/\//g, "-");
}
