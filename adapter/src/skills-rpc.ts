// Lists the user's personal skills under ~/.labweaver/skills/<name>/SKILL.md.
// Org skills live apart, in <workspace>/shared/skills (org-skills-rpc.ts), so
// every real directory here is the user's own. Symlinks are skipped: nothing
// legitimate links in, and following one could expose files outside the folder.
// Pure read-only file walk. Empty array when the directory does not exist.

import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractDescription } from "./frontmatter.js";
import { labweaverPath } from "./labweaver-dir.js";
import type { SkillSummary } from "./rpc-contract.js";

export async function listUserSkills(home: string): Promise<SkillSummary[]> {
  const skillsDir = labweaverPath(home, "skills");
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: SkillSummary[] = [];
  for (const it of entries) {
    if (!it.isDirectory()) continue;
    let manifest: string;
    try {
      manifest = await readFile(join(skillsDir, it.name, "SKILL.md"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    out.push({ name: it.name, description: extractDescription(manifest) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** SKILL.md of one personal skill, by the same rules as listUserSkills. */
export async function readUserSkillManifest(home: string, name: string): Promise<string> {
  if (
    !name ||
    typeof name !== "string" ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    name.startsWith(".")
  ) {
    throw new Error(`invalid skill name: ${name}`);
  }
  const skillDir = labweaverPath(home, "skills", name);
  let st;
  try {
    st = await lstat(skillDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`skill not found: ${name}`);
    throw e;
  }
  if (!st.isDirectory()) throw new Error(`not a personal skill: ${name}`);
  return await readFile(join(skillDir, "SKILL.md"), "utf8");
}
