#!/usr/bin/env node
// Adapter entrypoint. Per-user devcontainer runs one of these.
//
// Env:
//   NATS_SERVERS      e.g. "nats://pantheon-nats:4222"
//   SERVICE_ID        REQUIRED — random secret (hub/scripts/service-id.sh); the
//                     RPC subject is pantheon.service.<SERVICE_ID>
//   NATS_USER         optional auth user (defaults to "agent")
//   NATS_PASS         optional auth token
//   WORKSPACE_ROOT    default "/workspace"
//   DEFAULT_PROJECT   default "/workspace" (cwd for agent turns)
//   HOME              default "/home/node"
//   PG_URL            REQUIRED (Phase 2) — postgres connection string
//   USERNAME          REQUIRED (Phase 2) — tenant key for all chat queries
//   KERNEL_IDLE_CULL_MS           default 0 (disabled); when >0, cull a kernel
//                                 idle for this many ms (no in-flight executes)
//   KERNEL_CULL_CHECK_INTERVAL_MS default 60000; how often to check
//   DEEPSEEK_API_KEY  DeepSeek provider key
//   OLLAMA_API_KEY    Ollama Cloud provider key
//   OLLAMA_BASE_URL   default "https://ollama.com/v1"
//   OLLAMA_CLOUD_MODELS comma-separated Ollama Cloud model ids to offer
//   DSH_HOME          DeepSeek Harness state (sessions, config); default "$HOME/.dsh"
//   DSH_BIN           dsh CLI entry; default the bundled @deepseek-ai/dsh
//   DSH_NODE          node binary for dsh (needs >= 22.19); default this process's
//   DSH_PERMISSION_MODE default "danger-full-access" (headless, like bypassPermissions)
//   MCP_CONFIG        Claude-style .mcp.json forwarded to sessions; default "$WORKSPACE_ROOT/.mcp.json"

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { Pool } from "pg";
import { ChatsRepo } from "./chats-repo.js";
import { DshAcpConnection } from "./dsh/acp-connection.js";
import { DshAcpEngine } from "./dsh/engine.js";
import { buildDshPatch, serializePatch } from "./dsh/patch.js";
import { loadMcpServers } from "./mcp-config.js";
import { buildProviders, DEFAULT_MODEL_REF, type ProviderSpec } from "./providers/registry.js";
import { loadDbConfig } from "./db-config.js";
import { MemoryRpcClient } from "./memory-rpc.js";
import { NatsBus } from "./nats-bus.js";
import { ShareRpcClient } from "./share-rpc.js";
import { RpcRouter, type RpcDeps } from "./rpc.js";
import { importSidecar } from "./sidecar-import.js";
import { startUploadServer } from "./upload-http.js";

/** A NATS subject token, long enough to be unguessable. */
const SERVICE_ID_RE = /^[A-Za-z0-9_-]{32,}$/;

async function main(): Promise<void> {
  const serviceId = requireEnv("SERVICE_ID");
  if (!SERVICE_ID_RE.test(serviceId)) {
    console.error("[adapter] SERVICE_ID must be >= 32 chars of [A-Za-z0-9_-]; generate one with hub/scripts/service-id.sh");
    process.exit(2);
  }
  const servers = process.env.NATS_SERVERS ?? "nats://localhost:4222";
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? "/workspace";
  const defaultProjectCwd = process.env.DEFAULT_PROJECT ?? workspaceRoot;
  const home = process.env.HOME ?? "/home/node";

  const bus = new NatsBus({
    servers,
    serviceId,
    user: process.env.NATS_USER ?? "agent",
    pass: process.env.NATS_PASS,
    subjectPrefix: process.env.NATS_SUBJECT_PREFIX,
  });

  const dbCfg = loadDbConfig();
  if (!dbCfg.enabled) {
    console.error("[adapter] PG_URL is required in Phase 2. Refusing to boot.");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: dbCfg.pgUrl, max: 10 });
  // An idle client losing its connection (e.g. postgres restart) emits here;
  // unhandled, it would crash the adapter. The pool reconnects on next use.
  pool.on("error", (err) => console.warn(`[adapter] idle PG client error: ${err.message}`));
  await waitForPg(pool, 60);
  console.log(`[adapter] connected to PG as user=${dbCfg.username}`);

  // Best-effort one-shot import of legacy sidecar files. Runs in the
  // background; a subsequent boot is a no-op once the sentinel is written.
  importSidecar({ pool, username: dbCfg.username, workspaceRoot })
    .then((r) => console.log(`[adapter] sidecar import: imported=${r.imported} skipped=${r.skipped}`))
    .catch((err) => console.warn("[adapter] sidecar import failed:", err));

  const chatsRepo = new ChatsRepo(pool, dbCfg.username);

  const memoryApiUrl = process.env.MEMORY_API_URL;
  const memoryClient = memoryApiUrl
    ? new MemoryRpcClient(memoryApiUrl, dbCfg.username)
    : null;
  if (!memoryClient) {
    console.warn("[adapter] MEMORY_API_URL not set — memory_* RPCs will be unavailable");
  }

  const shareClient = memoryApiUrl
    ? new ShareRpcClient(memoryApiUrl, dbCfg.username)
    : null;
  if (!shareClient) {
    console.warn("[adapter] MEMORY_API_URL not set — share_* RPCs will be unavailable");
  }

  const providers = buildProviders();
  const engine = await createEngine({ home, workspaceRoot, providers });

  await bus.connect();
  console.log(`[adapter] connected to NATS ${servers}, service_id=${serviceId.slice(0, 12)}...`);

  const router = new RpcRouter({
    serviceId,
    workspaceRoot,
    chats: chatsRepo,
    home,
    defaultProjectCwd,
    publishStream: (streamId, ev) => bus.publishStream(streamId, ev),
    publishRaw: (subject, envelope) => bus.publishRaw(subject, envelope),
    streamSubject: (streamId) => bus.subjectFor(streamId),
    kernelBridgePath: process.env.KERNEL_BRIDGE_PATH ?? "/opt/adapter/kernel-bridge.py",
    kernelIdleCullMs: parsePositiveInt(process.env.KERNEL_IDLE_CULL_MS, 0),
    kernelCullCheckIntervalMs: parsePositiveInt(
      process.env.KERNEL_CULL_CHECK_INTERVAL_MS,
      60_000,
    ),
    memory: memoryClient,
    share: shareClient,
    engine,
    providers,
  });

  await bus.serve((method, params) => router.dispatch(method, params));
  console.log("[adapter] serving RPCs");

  // HTTP upload server. Listens on UPLOAD_PORT (default 5000) inside the
  // container; nginx proxies authenticated /upload/* requests here. If the
  // port is in use, log and continue — NATS RPC stays available.
  const uploadPort = parsePositiveInt(process.env.UPLOAD_PORT, 5000);
  let uploadServer: ReturnType<typeof startUploadServer> | undefined;
  try {
    uploadServer = startUploadServer({
      workspaceRoot,
      port:         uploadPort,
      username:     dbCfg.username,
      memoryApiUrl,
    });
  } catch (err) {
    console.warn(`[upload] failed to start on :${uploadPort}:`, err);
  }

  const shutdown = async (sig: string) => {
    console.log(`[adapter] ${sig} received, shutting down`);
    router.abortAll();
    await new Promise((r) => setTimeout(r, 500)); // let aborts flush
    await engine.close().catch(() => undefined);
    await new Promise<void>((r) => {
      if (!uploadServer) return r();
      uploadServer.close(() => r());
    });
    await bus.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/**
 * DeepSeek Harness engine: writes the adapter's cordis patch (providers,
 * skill roots, Claude-compatible hooks) into DSH_HOME and prepares the ACP
 * child, which spawns lazily on the first turn.
 */
async function createEngine(opts: { home: string; workspaceRoot: string; providers: ProviderSpec[] }): Promise<DshAcpEngine> {
  const dshHome = process.env.DSH_HOME ?? path.join(opts.home, ".dsh");
  mkdirSync(dshHome, { recursive: true });
  const settingsPath = path.join(opts.home, ".claude", "settings.json");
  const patchFile = path.join(dshHome, "labweaver.patch.yml");
  writeFileSync(patchFile, serializePatch(buildDshPatch({
    providers: opts.providers,
    defaultModel: DEFAULT_MODEL_REF,
    // Per-user skills first so they win name collisions with org skills.
    skillDirs: [path.join(opts.workspaceRoot, ".claude", "skills"), path.join(opts.home, ".claude", "skills")],
    hooksConfigPath: existsSync(settingsPath) ? settingsPath : undefined,
    // Same relative path from src/ (tsx dev) and dist/ (build).
    pluginsDirUrl: new URL("../dsh-plugins/", import.meta.url).href,
    // Read once at startup: editing .mcp.json takes an adapter restart.
    mcpServers: await loadMcpServers(process.env.MCP_CONFIG ?? path.join(opts.workspaceRoot, ".mcp.json")),
  })));

  const dshBin = process.env.DSH_BIN
    ?? createRequire(import.meta.url).resolve("@deepseek-ai/dsh/lib/bin.js");
  const conn = new DshAcpConnection({
    dshBin,
    nodeBin: process.env.DSH_NODE,
    patches: [patchFile],
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? "danger-full-access",
    },
  });
  console.log(`[adapter] engine: dsh acp (DSH_HOME=${dshHome}, patch=${patchFile})`);
  return new DshAcpEngine(conn, {
    usageDir: path.join(dshHome, "usage"),
  });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[adapter] missing required env ${name}`);
    process.exit(2);
  }
  return v;
}

function parsePositiveInt(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function waitForPg(pool: Pool, maxSec: number): Promise<void> {
  const deadline = Date.now() + maxSec * 1000;
  let delay = 500;
  while (Date.now() < deadline) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      console.warn(`[adapter] waiting for PG: ${(err as Error).message} (retry in ${delay}ms)`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 10_000);
    }
  }
  throw new Error(`PG unreachable after ${maxSec}s`);
}

main().catch((err) => {
  console.error("[adapter] fatal:", err);
  process.exit(1);
});
