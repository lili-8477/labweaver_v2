import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { listUserSkills, readUserSkillManifest } from "../src/skills-rpc.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "home-"));
});

describe("listUserSkills", () => {
  it("returns [] when ~/.labweaver/skills does not exist", async () => {
    expect(await listUserSkills(home)).toEqual([]);
  });

  it("lists each subdir that contains SKILL.md", async () => {
    const make = async (n: string, body: string) => {
      const d = path.join(home, ".labweaver", "skills", n);
      await mkdir(d, { recursive: true });
      await writeFile(path.join(d, "SKILL.md"), body);
    };
    await make("alpha", `---\ndescription: alpha skill\n---\nbody`);
    await make("beta",  `---\ndescription: "beta with quotes"\n---\nbody`);
    await mkdir(path.join(home, ".labweaver", "skills", "no-manifest"), { recursive: true });

    const r = await listUserSkills(home);
    expect(r).toEqual([
      { name: "alpha", description: "alpha skill" },
      { name: "beta",  description: "beta with quotes" },
    ]);
  });

  it("returns empty description when frontmatter is missing or has no description", async () => {
    const d = path.join(home, ".labweaver", "skills", "x");
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, "SKILL.md"), "no frontmatter here\n");
    expect(await listUserSkills(home)).toEqual([{ name: "x", description: "" }]);
  });
});

describe("readUserSkillManifest", () => {
  it("returns the SKILL.md body for a personal skill", async () => {
    const d = path.join(home, ".labweaver", "skills", "alpha");
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, "SKILL.md"), "---\ndescription: a\n---\nbody\n");
    expect(await readUserSkillManifest(home, "alpha"))
      .toBe("---\ndescription: a\n---\nbody\n");
  });

  it("refuses a symlink, even one that points at a skill", async () => {
    const elsewhere = path.join(home, "elsewhere", "gamma");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "SKILL.md"), "org body\n");
    const link = path.join(home, ".labweaver", "skills", "gamma");
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(elsewhere, link);
    await expect(readUserSkillManifest(home, "gamma")).rejects.toThrow(/not a personal skill/);
    expect(await listUserSkills(home)).toEqual([]);
  });

  it.each([
    "../etc/passwd",
    "foo/SKILL.md",
    ".hidden",
    "",
  ])("rejects unsafe name %p", async (n) => {
    await expect(readUserSkillManifest(home, n))
      .rejects.toThrow(/invalid skill name/);
  });

  it("throws when the skill does not exist", async () => {
    await mkdir(path.join(home, ".labweaver", "skills"), { recursive: true });
    await expect(readUserSkillManifest(home, "missing"))
      .rejects.toThrow(/skill not found/);
  });
});
