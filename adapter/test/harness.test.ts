import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { autoModePrompt, enterAutoMode, leaveAutoMode, recordedProject, sessionFile } from "../src/harness.js";

describe("auto mode helpers", () => {
  let home: string;
  const ws = "/workspace";
  const sid = "s1";

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "harness-"));
  });

  it("routes typed messages to /tick and leaves slash commands alone", () => {
    expect(autoModePrompt("analyse GSE123")).toBe("/tick analyse GSE123");
    expect(autoModePrompt("/memory")).toBe("/memory");
  });

  it("marks only the given session, with its bound project or none", async () => {
    await enterAutoMode(home, ws, sid, "local_projects/pbmc");
    expect(readFileSync(sessionFile(home, sid), "utf8")).toBe("/workspace/local_projects/pbmc\n");
    expect(existsSync(sessionFile(home, "s2"))).toBe(false);
    await enterAutoMode(home, ws, sid, null);
    expect(readFileSync(sessionFile(home, sid), "utf8")).toBe("");
    await leaveAutoMode(home, sid);
    expect(existsSync(sessionFile(home, sid))).toBe(false);
  });

  it("reads back the recorded project only when inside the workspace", async () => {
    expect(await recordedProject(home, ws, sid)).toBeNull();
    await enterAutoMode(home, ws, sid, null);
    writeFileSync(sessionFile(home, sid), "/workspace/local_projects/pbmc\n");
    expect(await recordedProject(home, ws, sid)).toBe("local_projects/pbmc");
    writeFileSync(sessionFile(home, sid), "/etc\n");
    expect(await recordedProject(home, ws, sid)).toBeNull();
  });
});
