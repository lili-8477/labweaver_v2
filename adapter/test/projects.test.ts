import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, listProjects } from "../src/projects.js";

describe("projects", () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "labweaver-proj-")); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("lists project folders, skipping hidden/underscore dirs and files", async () => {
    const lp = path.join(root, "local_projects");
    await fs.mkdir(path.join(lp, "pbmc"), { recursive: true });
    await fs.mkdir(path.join(lp, ".chat-attachments"));
    await fs.mkdir(path.join(lp, "_starter_pipelines"));
    await fs.writeFile(path.join(lp, "notes.txt"), "");
    expect((await listProjects(root)).map((p) => p.dir)).toEqual(["local_projects/pbmc"]);
  });

  it("missing root lists nothing", async () => {
    expect(await listProjects(root)).toEqual([]);
  });

  it("create slugifies the name and suffixes on collision", async () => {
    expect((await createProject(root, "PBMC QC!")).dir).toBe("local_projects/pbmc-qc");
    expect((await createProject(root, "pbmc qc")).dir).toBe("local_projects/pbmc-qc-2");
    await expect(createProject(root, "!!!")).rejects.toThrow();
  });
});
