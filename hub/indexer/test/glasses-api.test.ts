import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { classifyName, glassesRoutesPlugin } from "../src/glasses-api.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const ID = "20260929-101500-ab12";
const API = "/api/glasses";
const REC = `${API}/recordings/${ID}`;
const SECRET = "proxy-secret-for-tests";
const USER = { "x-forwarded-user": "alice", "x-glasses-proxy-secret": SECRET };

let pg: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;
let root: string;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const KIND: Record<string, string> = { mp4: "init", m4s: "media", jsonl: "events", json: "manifest", bin: "chunk" };

function create(headers: Record<string, string> = USER, localId = ID) {
  return app.inject({
    method: "POST", url: `${API}/recordings`, headers,
    payload: { localId, startedAt: "2026-09-29T10:15:00Z",
      device: { id: "d1", name: "RB Meta" }, config: { resolution: "medium", fps: 24 } },
  });
}

function putFile(name: string, body: Buffer | string, extra: Record<string, string> = {}, owner = "alice") {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return app.inject({
    method: "PUT", url: `${REC}/files/${name}`,
    headers: {
      "x-forwarded-user": owner, "x-glasses-proxy-secret": SECRET, "content-type": "application/octet-stream",
      "x-file-sha256": sha(buf), "x-file-kind": KIND[name.split(".").pop()!]!, ...extra,
    },
    payload: buf,
  });
}

function manifest(files: string[]) {
  return JSON.stringify({ recordingId: ID, mediaParts: [{ index: 1, files: files.map((file) => ({ file })) }] });
}

function complete() {
  return app.inject({ method: "POST", url: `${REC}/complete`, headers: USER,
    payload: { durationMs: 1000, endedAt: "2026-09-29T10:16:00Z", fileCount: 4 } });
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await pg?.stop();
}, 30_000);

beforeEach(async () => {
  await pool.query("TRUNCATE glasses_recordings CASCADE");
  await app?.close();
  root = await mkdtemp(path.join(tmpdir(), "glasses-"));
  app = Fastify({ logger: false });
  await app.register(glassesRoutesPlugin({ pool, recordingsRoot: root, maxChunkBytes: 1024 * 1024, proxySecret: SECRET }));
});

describe("classifyName", () => {
  it("accepts the phone's four name shapes", () => {
    expect(classifyName("p001-video-init.mp4")).toEqual({ kind: "init", track: "video", part: 1 });
    expect(classifyName("seg-000042-audio.m4s")).toEqual({ kind: "media", track: "audio", seq: 42 });
    expect(classifyName("events.jsonl")).toEqual({ kind: "events", track: null });
    expect(classifyName("manifest.json")).toEqual({ kind: "manifest", track: null });
    expect(classifyName("orig-001-c0002.bin")).toEqual({ kind: "chunk", track: null, part: 1, seq: 2 });
  });

  it("rejects anything else", () => {
    for (const n of ["p1-video-init.mp4", "seg-000001-depth.m4s", "../manifest.json", "notes.txt",
                     "orig-1-c0001.bin", "orig-001.mp4"]) {
      expect(classifyName(n)).toBeNull();
    }
  });
});

describe("auth and ping", () => {
  it("ping is 200 {ok:true} for a forwarded user", async () => {
    const res = await app.inject({ method: "GET", url: `${API}/ping`, headers: USER });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("401 without a forwarded user, or with one that fails the add-user.sh rule", async () => {
    expect((await app.inject({ method: "GET", url: `${API}/ping` })).statusCode).toBe(401);
    expect((await create({ ...USER, "x-forwarded-user": "../etc" })).statusCode).toBe(401);
  });

  it("401 for a forwarded user without the proxy secret, or with a wrong one", async () => {
    // What a process in a user's container could send straight to the indexer.
    expect((await create({ "x-forwarded-user": "alice" })).statusCode).toBe(401);
    expect((await create({ "x-forwarded-user": "alice", "x-glasses-proxy-secret": "guess" })).statusCode).toBe(401);
    expect((await create({ "x-forwarded-user": "alice", "x-glasses-proxy-secret": SECRET + "x" })).statusCode).toBe(401);
  });

  it("401 for everything when no secret is configured", async () => {
    const open = Fastify({ logger: false });
    await open.register(glassesRoutesPlugin({ pool, recordingsRoot: root, maxChunkBytes: 1024, proxySecret: "" }));
    const res = await open.inject({ method: "GET", url: `${API}/ping`,
      headers: { "x-forwarded-user": "alice", "x-glasses-proxy-secret": "" } });
    expect(res.statusCode).toBe(401);
    await open.close();
  });
});

describe("POST /recordings", () => {
  it("201 then 200 with the same id, and creates the owner-scoped folder", async () => {
    const first = await create();
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ recordingId: ID });
    const again = await create();
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ recordingId: ID });
    expect(await readdir(path.join(root, "alice", ID))).toEqual([]);
  });

  it("400 for a missing startedAt or an unsafe localId", async () => {
    const res = await app.inject({ method: "POST", url: `${API}/recordings`, headers: USER, payload: { localId: ID } });
    expect(res.statusCode).toBe(400);
    expect((await create(USER, "../x")).statusCode).toBe(400);
  });
});

describe("PUT files", () => {
  const body = Buffer.from("fmp4 segment bytes");

  it("404 before the recording exists", async () => {
    expect((await putFile("seg-000001-video.m4s", body)).statusCode).toBe(404);
  });

  it("201 stores the file under its name; a retry is 200", async () => {
    await create();
    expect((await putFile("p001-video-init.mp4", body, { "x-file-track": "video", "x-file-part": "1" })).statusCode).toBe(201);
    expect(await readFile(path.join(root, "alice", ID, "p001-video-init.mp4"))).toEqual(body);
    expect((await putFile("p001-video-init.mp4", body)).statusCode).toBe(200);
  });

  it("records the X-File-* headers", async () => {
    await create();
    await putFile("seg-000003-audio.m4s", body, {
      "x-file-track": "audio", "x-file-part": "2", "x-file-seq": "3",
      "x-file-start-ms": "20000", "x-file-duration-ms": "10000",
    });
    const r = await pool.query("SELECT kind, track, part, seq, start_ms, duration_ms, bytes FROM glasses_files");
    expect(r.rows[0]).toEqual({ kind: "media", track: "audio", part: 2, seq: 3,
      start_ms: "20000", duration_ms: "10000", bytes: String(body.length) });
  });

  it("400 for a hash mismatch, and nothing is stored", async () => {
    await create();
    const res = await putFile("seg-000001-video.m4s", body, { "x-file-sha256": "0".repeat(64) });
    expect(res.statusCode).toBe(400);
    expect(await readdir(path.join(root, "alice", ID))).toEqual([]);
  });

  it("400 for a bad name, a wrong kind or track, or a non-integer header", async () => {
    await create();
    expect((await putFile("notes.json", body)).statusCode).toBe(400);
    expect((await putFile("seg-000001-video.m4s", body, { "x-file-kind": "init" })).statusCode).toBe(400);
    expect((await putFile("seg-000001-video.m4s", body, { "x-file-track": "audio" })).statusCode).toBe(400);
    expect((await putFile("seg-000001-video.m4s", body, { "x-file-seq": "one" })).statusCode).toBe(400);
    expect((await putFile("seg-000001-video.m4s", body, { "x-file-sha256": sha(body).toUpperCase() })).statusCode).toBe(400);
  });

  it("409 for different bytes under the same name; the first file is kept", async () => {
    await create();
    await putFile("seg-000005-audio.m4s", body);
    expect((await putFile("seg-000005-audio.m4s", "other")).statusCode).toBe(409);
    expect(await readFile(path.join(root, "alice", ID, "seg-000005-audio.m4s"))).toEqual(body);
  });

  it("413 over the size limit", async () => {
    await create();
    expect((await putFile("seg-000001-video.m4s", Buffer.alloc(2 * 1024 * 1024))).statusCode).toBe(413);
  });

  it("owners are isolated", async () => {
    await create();
    expect((await putFile("seg-000001-video.m4s", body, {}, "bob")).statusCode).toBe(404);
  });
});

describe("complete", () => {
  const seg = Buffer.from("seg");
  const files = ["p001-video-init.mp4", "seg-000001-video.m4s"];

  it("409 [manifest.json] before the manifest is uploaded", async () => {
    await create();
    const res = await complete();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ missing: ["manifest.json"] });
  });

  it("409 lists the missing media files and events.jsonl", async () => {
    await create();
    await putFile("p001-video-init.mp4", seg);
    await putFile("manifest.json", manifest(files));
    const res = await complete();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ missing: ["seg-000001-video.m4s", "events.jsonl"] });
  });

  it("202 {ok:true} once everything arrived; repeat is 202; later uploads 409", async () => {
    await create();
    await putFile("p001-video-init.mp4", seg);
    await putFile("seg-000001-video.m4s", seg);
    await putFile("events.jsonl", '{"t":0,"type":"session_state","payload":{}}\n');
    await putFile("manifest.json", manifest(files));
    const res = await complete();
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    const row = await pool.query(
      "SELECT state, duration_ms, manifest->>'recordingId' AS m FROM glasses_recordings");
    expect(row.rows[0]).toEqual({ state: "complete", duration_ms: "1000", m: ID });

    expect((await complete()).statusCode).toBe(202);
    expect((await putFile("seg-000002-video.m4s", seg)).statusCode).toBe(409);
  });

  it("after muxing (processed or mux_failed), complete is still 202 and uploads are 409", async () => {
    await create();
    for (const state of ["processed", "mux_failed"]) {
      await pool.query("UPDATE glasses_recordings SET state = $1", [state]);
      expect((await complete()).statusCode).toBe(202);
      expect((await putFile("seg-000009-video.m4s", seg)).statusCode).toBe(409);
    }
  });

  it("400 when manifest.json is not JSON or names another recording", async () => {
    await create();
    await putFile("manifest.json", "{not json");
    expect((await complete()).statusCode).toBe(400);
    await pool.query("TRUNCATE glasses_recordings CASCADE");
    await create();
    await putFile("manifest.json", JSON.stringify({ recordingId: "other", mediaParts: [] }));
    expect((await complete()).statusCode).toBe(400);
  });
});

describe("read routes", () => {
  const get = (url: string, headers: Record<string, string> = USER) =>
    app.inject({ method: "GET", url, headers });

  async function seedRec(owner: string, id: string, startedAt: string, state: string, parts = 0) {
    await pool.query(
      `INSERT INTO glasses_recordings (owner, recording_id, started_at, ended_at, duration_ms, state)
       VALUES ($1, $2, $3, $3::timestamptz + interval '1 minute', 60000, $4)`, [owner, id, startedAt, state]);
    for (let i = 1; i <= parts; i++) {
      await pool.query(
        `INSERT INTO glasses_parts (owner, recording_id, part, file, bytes, duration_ms, width, height,
                                    has_audio, start_ms, end_ms)
         VALUES ($1, $2, $3, $4, 5278973, 87936, 360, 640, true, 6374, 94165)`,
        [owner, id, i, `muxed/p00${i}.mp4`]);
    }
  }

  it("lists the owner's recordings newest first, with part counts and a limit", async () => {
    await seedRec("alice", "20260929-090000-aaaa", "2026-09-29T09:00:00Z", "processed", 2);
    await seedRec("alice", "20260929-100000-bbbb", "2026-09-29T10:00:00Z", "uploading");
    await seedRec("bob",   "20260929-110000-cccc", "2026-09-29T11:00:00Z", "processed", 1);
    const res = await get(`${API}/recordings`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ recordings: [
      { recordingId: "20260929-100000-bbbb", source: "stream", type: null, startedAt: "2026-09-29T10:00:00.000Z",
        endedAt: "2026-09-29T10:01:00.000Z", durationMs: 60000, state: "uploading", partCount: 0 },
      { recordingId: "20260929-090000-aaaa", source: "stream", type: null, startedAt: "2026-09-29T09:00:00.000Z",
        endedAt: "2026-09-29T09:01:00.000Z", durationMs: 60000, state: "processed", partCount: 2 },
    ] });
    expect((await get(`${API}/recordings?limit=1`)).json().recordings).toHaveLength(1);
    expect((await get(`${API}/recordings?limit=0`)).statusCode).toBe(400);
  });

  it("parts: [] with the state before muxing, the rows after, 404 for unknown or another owner's", async () => {
    await seedRec("alice", "r-waiting", "2026-09-29T09:00:00Z", "complete");
    await seedRec("alice", "r-done", "2026-09-29T10:00:00Z", "processed", 1);
    await seedRec("bob", "r-bob", "2026-09-29T10:00:00Z", "processed", 1);
    expect((await get(`${REC.replace(ID, "r-waiting")}/parts`)).json())
      .toEqual({ recordingId: "r-waiting", state: "complete", parts: [] });
    expect((await get(`${API}/recordings/r-done/parts`)).json()).toEqual({
      recordingId: "r-done", state: "processed",
      parts: [{ part: 1, file: "p001.mp4", bytes: 5278973, durationMs: 87936, width: 360, height: 640,
                hasAudio: true, startMs: 6374, endMs: 94165 }],
    });
    expect((await get(`${API}/recordings/nope/parts`)).statusCode).toBe(404);
    expect((await get(`${API}/recordings/r-bob/parts`)).statusCode).toBe(404);
  });

  it("download hands the file to nginx via X-Accel-Redirect", async () => {
    await seedRec("alice", "r-done", "2026-09-29T10:00:00Z", "processed", 2);
    const res = await get(`${API}/recordings/r-done/parts/2`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-accel-redirect"]).toBe("/_glasses_files/alice/r-done/muxed/p002.mp4");
    expect(res.body).toBe("");
  });

  it("download: 404 with the state before muxing or for a missing part; 400 for a bad n", async () => {
    await seedRec("alice", "r-waiting", "2026-09-29T09:00:00Z", "complete");
    const res = await get(`${API}/recordings/r-waiting/parts/1`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "part not found", state: "complete" });
    expect((await get(`${API}/recordings/nope/parts/1`)).statusCode).toBe(404);
    for (const n of ["0", "01", "x", "..%2F1"]) {
      expect((await get(`${API}/recordings/r-waiting/parts/${n}`)).statusCode).toBe(400);
    }
  });

  it("read routes need the proxy secret too", async () => {
    await seedRec("alice", "r-done", "2026-09-29T10:00:00Z", "processed", 1);
    for (const url of [`${API}/recordings`, `${API}/recordings/r-done/parts`, `${API}/recordings/r-done/parts/1`]) {
      expect((await get(url, { "x-forwarded-user": "alice" })).statusCode).toBe(401);
    }
  });
});

describe("v1 base URL", () => {
  it("every route also answers under /api/glasses/v1", async () => {
    const res = await app.inject({ method: "POST", url: `${API}/v1/recordings`, headers: USER,
      payload: { localId: ID, startedAt: "2026-09-29T10:15:00Z" } });
    expect(res.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `${API}/v1/recordings/${ID}/parts`, headers: USER })).json())
      .toEqual({ recordingId: ID, state: "uploading", parts: [] });
  });
});

describe("imported originals (v1.1)", () => {
  const IMP = "20261020-104512-m3f9a";
  const IREC = `${API}/recordings/${IMP}`;
  const c1 = Buffer.from("first chunk of the original;");
  const c2 = Buffer.from("second chunk");
  const whole = Buffer.concat([c1, c2]);
  const CHUNKS = ["orig-001-c0001.bin", "orig-001-c0002.bin"];

  function createImport(type: string = "video") {
    return app.inject({ method: "POST", url: `${API}/recordings`, headers: USER,
      payload: { localId: IMP, startedAt: "2026-10-20T16:45:12Z", source: "meta-ai",
        device: { make: "Meta", model: "Ray-Ban Meta" }, config: { type } } });
  }

  function putChunk(name: string, body: Buffer, extra: Record<string, string> = {}) {
    const [, part, seq] = /orig-(\d{3})-c(\d{4})/.exec(name)!;
    return app.inject({ method: "PUT", url: `${IREC}/files/${name}`,
      headers: { ...USER, "content-type": "application/octet-stream", "x-file-sha256": sha(body),
        "x-file-kind": "chunk", "x-file-part": part!, "x-file-seq": seq!, ...extra },
      payload: body });
  }

  function putImportFile(name: string, body: string, kind: string) {
    const buf = Buffer.from(body);
    return app.inject({ method: "PUT", url: `${IREC}/files/${name}`,
      headers: { ...USER, "content-type": "application/octet-stream", "x-file-sha256": sha(buf), "x-file-kind": kind },
      payload: buf });
  }

  const importManifest = (over: Record<string, unknown> = {}) => JSON.stringify({
    recordingId: IMP, source: "meta-ai", startedAt: "2026-10-20T16:45:12Z", endedAt: "2026-10-20T16:45:41Z",
    durationMs: 29000, config: { type: "video" }, mediaParts: [],
    originals: [{ index: 1, file: "orig-001.mp4", type: "video", bytes: whole.length, sha256: sha(whole),
      chunks: CHUNKS, capturedAt: "2026-10-20T16:45:12Z", durationMs: 29000, width: 1440, height: 1920,
      originalFilename: "IMG_1234.MP4", ...over }],
  });

  const completeImport = () => app.inject({ method: "POST", url: `${IREC}/complete`, headers: USER, payload: {} });

  async function uploadAll(manifestJson = importManifest()) {
    await createImport();
    await putChunk(CHUNKS[0]!, c1);
    await putChunk(CHUNKS[1]!, c2);
    await putImportFile("events.jsonl", "", "events");
    await putImportFile("manifest.json", manifestJson, "manifest");
  }

  it("creates with source meta-ai; config.type must be video or photo", async () => {
    expect((await createImport()).statusCode).toBe(201);
    const r = await pool.query("SELECT source, config FROM glasses_recordings");
    expect(r.rows[0]).toEqual({ source: "meta-ai", config: { type: "video" } });
    await pool.query("TRUNCATE glasses_recordings CASCADE");
    expect((await createImport("audio")).statusCode).toBe(400);
  });

  it("stores chunks with part and seq; rejects X-File-Track on a chunk", async () => {
    await createImport();
    expect((await putChunk(CHUNKS[1]!, c2)).statusCode).toBe(201);
    expect((await putChunk(CHUNKS[1]!, c2)).statusCode).toBe(200);
    expect((await putChunk(CHUNKS[0]!, c1, { "x-file-track": "video" })).statusCode).toBe(400);
    const r = await pool.query("SELECT kind, part, seq FROM glasses_files");
    expect(r.rows).toEqual([{ kind: "chunk", part: 1, seq: 2 }]);
  });

  it("409 lists missing chunks and events.jsonl", async () => {
    await createImport();
    await putChunk(CHUNKS[0]!, c1);
    await putImportFile("manifest.json", importManifest(), "manifest");
    const res = await completeImport();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ missing: [CHUNKS[1], "events.jsonl"] });
  });

  it("202 joins the chunks into the original, drops them, and a repeat is still 202", async () => {
    await uploadAll();
    const res = await completeImport();
    expect(res.statusCode).toBe(202);
    const dir = path.join(root, "alice", IMP);
    expect(await readFile(path.join(dir, "orig-001.mp4"))).toEqual(whole);
    expect((await readdir(dir)).sort()).toEqual(["events.jsonl", "manifest.json", "orig-001.mp4"]);
    expect((await pool.query("SELECT name FROM glasses_files WHERE kind = 'chunk'")).rows).toEqual([]);
    expect((await completeImport()).statusCode).toBe(202);
  });

  it("409 with all of an original's chunks on a sha256 mismatch, and they are dropped", async () => {
    await uploadAll(importManifest({ sha256: "0".repeat(64) }));
    const res = await completeImport();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ missing: CHUNKS });
    const dir = path.join(root, "alice", IMP);
    expect((await readdir(dir)).sort()).toEqual(["events.jsonl", "manifest.json"]);
    expect((await pool.query("SELECT state FROM glasses_recordings")).rows[0].state).toBe("uploading");
    // The phone resends the chunks; the same complete then succeeds once the bytes match.
    expect((await putChunk(CHUNKS[0]!, c1)).statusCode).toBe(201);
  });

  it("409 on a byte-count mismatch too", async () => {
    await uploadAll(importManifest({ bytes: whole.length + 1 }));
    expect((await completeImport()).json()).toEqual({ missing: CHUNKS });
  });

  it("400 when a meta-ai manifest has no originals, or names chunks of another index", async () => {
    await uploadAll(JSON.stringify({ recordingId: IMP, mediaParts: [] }));
    expect((await completeImport()).statusCode).toBe(400);
    await pool.query("TRUNCATE glasses_recordings CASCADE");
    await uploadAll(importManifest({ chunks: ["orig-002-c0001.bin"] }));
    expect((await completeImport()).statusCode).toBe(400);
  });

  it("GET /recordings shows source and type; /originals/n is 404 before complete, X-Accel after", async () => {
    await uploadAll();
    const get = (url: string) => app.inject({ method: "GET", url, headers: USER });
    expect((await get(`${API}/recordings`)).json().recordings[0])
      .toMatchObject({ recordingId: IMP, source: "meta-ai", type: "video", state: "uploading" });
    const before = await get(`${IREC}/originals/1`);
    expect(before.statusCode).toBe(404);
    expect(before.json()).toEqual({ error: "original not found", state: "uploading" });

    await completeImport();
    const after = await get(`${IREC}/originals/1`);
    expect(after.statusCode).toBe(200);
    expect(after.headers["x-accel-redirect"]).toBe(`/_glasses_files/alice/${IMP}/orig-001.mp4`);
    expect((await get(`${IREC}/originals/2`)).statusCode).toBe(404);
    expect((await get(`${IREC}/originals/0`)).statusCode).toBe(400);
  });
});
