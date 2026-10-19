// Workspace paths (GLOSSARY.md): every workspace-relative path that arrives
// from the UI — file browser, notebooks, h5ad, uploads, project bindings —
// resolves here, so containment and the access policy are decided once.
//
// Not a security boundary against the UI's user (the chat RPC can ask the
// agent to do anything in the container). It stops bugs and odd input from
// reading secrets or clobbering the harness files the agent runs on.

import * as path from "node:path";
import { LABWEAVER_DIR } from "./labweaver-dir.js";

export type Access = "read" | "write";

/** Secrets and host-leakage surfaces: never listed, read or written, at any depth. */
const SECRET_NAMES = new Set([
  ".env", ".ssh", ".aws", ".netrc", ".credentials", ".npmrc", ".pypirc", ".docker", ".executor", ".git",
]);

/** Top-level harness files the agent runs on: readable, never written by the UI. */
const HARNESS_NAMES = new Set([LABWEAVER_DIR, "CLAUDE.md", ".mcp.json"]);

/** Skills are the one harness subtree the UI writes (skill uploads). */
const WRITABLE_HARNESS_SUBTREE = [LABWEAVER_DIR, "skills"];

function isSecret(name: string): boolean {
  return SECRET_NAMES.has(name) || name.startsWith(".env.");
}

/** False for names a directory listing hides (secrets). */
export function isListed(name: string): boolean {
  return !isSecret(name);
}

/**
 * Resolve a workspace-relative path for `access`, or throw. Refuses absolute
 * paths, `..` segments, secrets (read and write) and harness files (write;
 * the skills subtree is exempt). Write also refuses the workspace root itself.
 */
export function workspacePath(root: string, rel: string, access: Access): string {
  if (path.isAbsolute(rel)) throw new Error(`path must be workspace-relative: ${rel}`);
  const segs = rel.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.includes("..")) throw new Error(`path must not contain "..": ${rel}`);
  const secret = segs.find(isSecret);
  if (secret) throw new Error(`access denied for secret path: ${rel}`);
  if (access === "write") {
    if (segs.length === 0) throw new Error("cannot write the workspace root");
    const inSkills = segs.length > WRITABLE_HARNESS_SUBTREE.length
      && WRITABLE_HARNESS_SUBTREE.every((s, i) => segs[i] === s);
    if (HARNESS_NAMES.has(segs[0]!) && !inSkills) {
      throw new Error(`access denied for harness path: ${rel}`);
    }
  }
  return path.join(root, ...segs);
}
