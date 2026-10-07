// Owns one long-lived `dsh --profile acp` child and the ACP client connection
// to it. Every chat shares the process; DSH multiplexes independent sessions
// over one connection. The child is spawned lazily and respawned on the next
// call after it exits.

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export interface DshAcpConnectionOptions {
  /** Path to the dsh CLI entry (`@deepseek-ai/dsh/lib/bin.js`). */
  dshBin: string;
  /** Absolute paths of cordis patches layered over the acp profile. */
  patches: string[];
  /** Child environment (API keys, DSH_HOME, DSH_PERMISSION_MODE). */
  env: NodeJS.ProcessEnv;
  /** Node binary that runs dsh (needs >= 22.19). */
  nodeBin?: string;
}

type UpdateListener = (update: acp.SessionUpdate) => void;

interface Live {
  child: ChildProcess;
  conn: acp.ClientSideConnection;
  /** Rejects when the child exits; raced against every request. */
  exited: Promise<never>;
  ready: Promise<void>;
  /** Sessions loaded into this process (new or resumed). */
  loaded: Set<string>;
  /** Last model route applied per session, to skip redundant switches. */
  models: Map<string, string>;
}

export class DshAcpConnection {
  private live: Live | null = null;
  private listeners = new Map<string, UpdateListener>();

  constructor(private readonly opts: DshAcpConnectionOptions) {}

  private start(): Live {
    if (this.live) return this.live;
    const child = spawn(this.opts.nodeBin ?? process.execPath, [
      this.opts.dshBin, "--profile", "acp", ...this.opts.patches.flatMap((p) => ["--patch", p]),
    ], { stdio: ["pipe", "pipe", "pipe"], env: this.opts.env });

    // Stdout is the protocol; stderr is diagnostics.
    child.stderr!.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) if (line.trim()) console.log(`[dsh] ${line}`);
    });

    const exited = new Promise<never>((_, reject) => {
      child.once("exit", (code, sig) => {
        if (this.live?.child === child) this.live = null;
        reject(new Error(`dsh exited (code=${code} signal=${sig})`));
      });
      child.once("error", (e) => {
        if (this.live?.child === child) this.live = null;
        reject(e);
      });
    });
    exited.catch(() => undefined); // observed via races below

    const conn = new acp.ClientSideConnection(() => ({
      sessionUpdate: async (n: acp.SessionNotification) => {
        this.listeners.get(n.sessionId)?.(n.update);
      },
      // Headless: DSH_PERMISSION_MODE=danger-full-access should mean no asks;
      // approve defensively so a stray ask never hangs a turn.
      requestPermission: async (req: acp.RequestPermissionRequest) => {
        const allow = req.options.find((o) => o.kind.startsWith("allow")) ?? req.options[0];
        return allow
          ? { outcome: { outcome: "selected", optionId: allow.optionId } }
          : { outcome: { outcome: "cancelled" } };
      },
    }), acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    ));

    const live: Live = { child, conn, exited, ready: Promise.resolve(), loaded: new Set(), models: new Map() };
    live.ready = Promise.race([
      conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }),
      exited,
    ]).then((init) => {
      console.log(`[dsh] acp ready: ${init.agentInfo?.name ?? "?"} v${init.agentInfo?.version ?? "?"}`);
    });
    this.live = live;
    return live;
  }

  private async call<T>(fn: (live: Live) => Promise<T>): Promise<T> {
    const live = this.start();
    await live.ready;
    return Promise.race([fn(live), live.exited]);
  }

  /** MCP servers are mounted process-wide through the patch, not per session. */
  async newSession(cwd: string): Promise<string> {
    return this.call(async (live) => {
      const res = await live.conn.newSession({ cwd, mcpServers: [] });
      live.loaded.add(res.sessionId);
      return res.sessionId;
    });
  }

  /** Loads a persisted session into this process; no-op if already loaded. */
  async resumeSession(sessionId: string, cwd: string): Promise<void> {
    return this.call(async (live) => {
      if (live.loaded.has(sessionId)) return;
      await live.conn.resumeSession({ sessionId, cwd, mcpServers: [] });
      live.loaded.add(sessionId);
    });
  }

  async setModel(sessionId: string, provider: string, model: string): Promise<void> {
    const value = JSON.stringify([provider, model]);
    return this.call(async (live) => {
      if (live.models.get(sessionId) === value) return;
      await live.conn.setSessionConfigOption({ sessionId, configId: "model", value });
      live.models.set(sessionId, value);
    });
  }

  async prompt(sessionId: string, prompt: acp.ContentBlock[], onUpdate: UpdateListener): Promise<acp.StopReason> {
    this.listeners.set(sessionId, onUpdate);
    try {
      return (await this.call((live) => live.conn.prompt({ sessionId, prompt }))).stopReason;
    } finally {
      if (this.listeners.get(sessionId) === onUpdate) this.listeners.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.live) return;
    await this.live.conn.cancel({ sessionId }).catch((e) => console.warn(`[dsh] cancel ${sessionId}:`, e));
  }

  /** EOF on stdin shuts dsh down; escalate if it lingers. */
  async close(timeoutMs = 5000): Promise<void> {
    const live = this.live;
    if (!live) return;
    this.live = null;
    live.child.stdin!.end();
    const done = live.exited.catch(() => undefined);
    const timer = setTimeout(() => live.child.kill("SIGTERM"), timeoutMs);
    await done;
    clearTimeout(timer);
  }
}
