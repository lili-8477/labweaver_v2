import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listClientModules } from "../src/dsh-client-modules.js";

let profile: string;

beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), "labweaver-dsh-profile-"));
});

afterEach(() => {
  rmSync(profile, { recursive: true, force: true });
});

function writeProfile(deps: string[]) {
  writeFileSync(join(profile, "package.json"), JSON.stringify({ dependencies: Object.fromEntries(deps.map((d) => [d, "*"])) }));
}

function writePkg(name: string, pkg: Record<string, unknown>, files: Record<string, string> = {}) {
  const dir = join(profile, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, ...pkg }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
}

const web = { dsh: { client: { platform: "web" } } };

describe("listClientModules", () => {
  it("returns [] for a missing or empty profile", async () => {
    expect(await listClientModules(join(profile, "nope"))).toEqual([]);
    writeProfile([]);
    expect(await listClientModules(profile)).toEqual([]);
  });

  it("returns the client bundle of each web plugin, string or conditional export", async () => {
    writeProfile(["@a/one", "two", "host-only"]);
    writePkg("@a/one", { ...web, exports: { "./client": { default: "./lib/client.js" } } }, { "lib/client.js": "ONE" });
    writePkg("two", { ...web, exports: { "./client": "./client.js" } }, { "client.js": "TWO" });
    writePkg("host-only", { exports: { "./client": "./client.js" } }, { "client.js": "NO" });
    expect(await listClientModules(profile)).toEqual([
      { id: "@a/one", code: "ONE" },
      { id: "two", code: "TWO" },
    ]);
  });

  it("skips a bundle outside its package or not built", async () => {
    writeProfile(["escape", "unbuilt"]);
    writePkg("escape", { ...web, exports: { "./client": "../../package.json" } });
    writePkg("unbuilt", { ...web, exports: { "./client": "./lib/client.js" } });
    expect(await listClientModules(profile)).toEqual([]);
  });
});
