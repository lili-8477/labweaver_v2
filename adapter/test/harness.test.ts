import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { autoModePrompt, isAutoMode, recordedProject, selectProject } from "../src/harness.js";

describe("auto mode helpers", () => {
  let home: string;
  const ws = "/workspace";
  const dirFile = () => path.join(home, ".claude", ".harness_dir");

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "harness-"));
    mkdirSync(path.join(home, ".claude"));
  });

  it("detects the marker file", async () => {
    expect(await isAutoMode(home)).toBe(false);
    writeFileSync(path.join(home, ".claude", ".harness_active"), "");
    expect(await isAutoMode(home)).toBe(true);
  });

  it("routes typed messages to /tick and leaves slash commands alone", () => {
    expect(autoModePrompt("analyse GSE123")).toBe("/tick analyse GSE123");
    expect(autoModePrompt("/memory")).toBe("/memory");
  });

  it("selects the bound project, or clears it for a new one", async () => {
    await selectProject(home, ws, "local_projects/pbmc");
    expect(readFileSync(dirFile(), "utf8")).toBe("/workspace/local_projects/pbmc\n");
    await selectProject(home, ws, null);
    expect(existsSync(dirFile())).toBe(false);
  });

  it("reads back the recorded project only when inside the workspace", async () => {
    expect(await recordedProject(home, ws)).toBeNull();
    writeFileSync(dirFile(), "/workspace/local_projects/pbmc\n");
    expect(await recordedProject(home, ws)).toBe("local_projects/pbmc");
    writeFileSync(dirFile(), "/etc\n");
    expect(await recordedProject(home, ws)).toBeNull();
  });
});
