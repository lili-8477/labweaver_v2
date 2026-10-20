import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startUploadServer } from "../src/upload-http.js";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("/share-snapshot/:id/file proxy", () => {
  let upload: Server, fakeIndexer: Server;
  let port: number, indexerPort: number;
  const seenUrls: string[] = [];

  beforeAll(async () => {
    const wsRoot = await mkdtemp(join(tmpdir(), "ws-"));

    fakeIndexer = createServer((req, res) => {
      seenUrls.push(req.url ?? "");
      if (req.url?.includes("path=missing")) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "file not in snapshot" }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/markdown");
      res.end("# hello");
    });
    await new Promise<void>(r => fakeIndexer.listen(0, () => r()));
    indexerPort = (fakeIndexer.address() as { port: number }).port;

    upload = startUploadServer({
      workspaceRoot: wsRoot,
      port:          0,
      username:      "alice",
      memoryApiUrl:  `http://127.0.0.1:${indexerPort}`,
    });
    await new Promise<void>(r => upload.once("listening", () => r()));
    port = (upload.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>(r => upload.close(() => r()));
    await new Promise<void>(r => fakeIndexer.close(() => r()));
  });

  it("proxies GET /share-snapshot/:id/file and injects actor=USERNAME", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/share-snapshot/abc/file?path=demo/SKILL.md`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("# hello");
    const last = seenUrls.at(-1)!;
    expect(last).toContain("/share/abc/snapshot/file");
    expect(last).toContain("actor=alice");
    expect(last).toMatch(/path=demo(%2F|\/)SKILL\.md/i);
  });

  it("propagates 404 from the upstream", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/share-snapshot/abc/file?path=missing.txt`);
    expect(r.status).toBe(404);
  });

  it("returns 503 when the adapter has no username configured", async () => {
    const tmpUp = startUploadServer({
      workspaceRoot: "/tmp",
      port:          0,
    });
    await new Promise<void>(r => tmpUp.once("listening", () => r()));
    const tmpPort = (tmpUp.address() as { port: number }).port;
    const r = await fetch(`http://127.0.0.1:${tmpPort}/share-snapshot/x/file?path=y`);
    expect(r.status).toBe(503);
    await new Promise<void>(r => tmpUp.close(() => r()));
  });
});

describe("PUT /upload/ path policy", () => {
  let upload: Server, port: number, wsRoot: string;

  beforeAll(async () => {
    wsRoot = await mkdtemp(join(tmpdir(), "ws-policy-"));
    upload = startUploadServer({ workspaceRoot: wsRoot, port: 0 });
    await new Promise<void>(r => upload.once("listening", () => r()));
    port = (upload.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>(r => upload.close(() => r()));
  });

  const put = (path: string, body = "x") =>
    fetch(`http://127.0.0.1:${port}/upload/${path}`, { method: "PUT", body });

  it("accepts a normal upload under local_projects/", async () => {
    const r = await put("local_projects/notes/a.txt", "hello");
    expect(r.status).toBe(201);
    const written = await readFile(join(wsRoot, "local_projects/notes/a.txt"), "utf8");
    expect(written).toBe("hello");
  });

  it("refuses what the workspace path policy refuses with 403 denied_path", async () => {
    const r = await put("local_projects/.env");
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "denied_path" });
  });

  it("rejects writes outside the allowed subtree", async () => {
    const r = await put("other/place/x.txt");
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "path_outside_allowed_subtree" });
  });

  it("accepts a skill upload under .labweaver/skills/", async () => {
    const r = await put(".labweaver/skills/demo/SKILL.md", "# demo");
    expect(r.status).toBe(201);
    const written = await readFile(join(wsRoot, ".labweaver/skills/demo/SKILL.md"), "utf8");
    expect(written).toBe("# demo");
  });

  it("still denies non-skills paths under .labweaver/", async () => {
    const r = await put(".labweaver/settings.json", "{}");
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "denied_path" });
  });

  it("rejects path traversal out of .labweaver/skills/", async () => {
    // .labweaver/skills/../foo resolves to <ws>/.labweaver/foo, outside the carve-out.
    const r = await put(".labweaver/skills/..%2Fpwned.txt");
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "denied_path" });
    // And no file should have been written.
    await expect(stat(join(wsRoot, ".labweaver/pwned.txt"))).rejects.toThrow();
  });
});
