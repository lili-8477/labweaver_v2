// AgentEngine backed by DeepSeek Harness over ACP.

import type { ContentBlock, McpServer } from "@agentclientprotocol/sdk";
import type { AgentEngine, EngineTurnArgs } from "../engine/types.js";
import { loadMcpServers } from "../mcp-config.js";
import { parseModelRef } from "../providers/registry.js";
import type { ImageRef } from "../rpc.js";
import type { DshAcpConnection } from "./acp-connection.js";
import { mapSessionUpdate } from "./acp-mapper.js";
import { takeTurnUsage } from "./usage.js";

export interface DshAcpEngineOptions {
  /** Claude Code–style .mcp.json forwarded to every session; optional. */
  mcpConfigPath?: string;
  /** Where dsh-plugins/usage.js records per-call token usage; omit to skip token totals. */
  usageDir?: string;
}

/**
 * Images travel as path references the agent opens with its `read_image`
 * tool. DSH fixes inline-image support at startup from the default route, so
 * paths work for every model, including text-only ones.
 */
export function buildPromptBlocks(text: string, images: ImageRef[]): ContentBlock[] {
  const refs = images.map((img) => `[attached image: ${img.path} (${img.mediaType}) — open it with read_image]`);
  return [{ type: "text", text: [...refs, text].filter(Boolean).join("\n") }];
}

export class DshAcpEngine implements AgentEngine {
  constructor(
    private readonly conn: DshAcpConnection,
    private readonly opts: DshAcpEngineOptions = {},
  ) {}

  async runTurn(args: EngineTurnArgs): Promise<void> {
    const route = parseModelRef(args.model);
    if (!route) throw new Error(`invalid model ref: ${args.model}`);
    const mcp: McpServer[] = this.opts.mcpConfigPath ? await loadMcpServers(this.opts.mcpConfigPath) : [];

    let sessionId = args.resumeSessionId;
    if (sessionId) {
      try {
        await this.conn.resumeSession(sessionId, args.cwd, mcp);
      } catch (e) {
        // Unknown to DSH (e.g. a pre-migration Claude session): start fresh.
        console.warn(`[engine] resume ${sessionId.slice(0, 8)} failed (${(e as Error).message}); starting fresh`);
        sessionId = undefined;
      }
    }
    if (!sessionId) sessionId = await this.conn.newSession(args.cwd, mcp);
    args.onSessionId(sessionId);
    if (args.signal.aborted) return;

    await this.conn.setModel(sessionId, route.provider, route.model);

    const id = sessionId;
    const onAbort = () => void this.conn.cancel(id);
    args.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const stop = await this.conn.prompt(id, buildPromptBlocks(args.prompt, args.images), (update) => {
        for (const ev of mapSessionUpdate(update)) args.onEvent(ev);
      });
      console.log(`[engine] turn ${id.slice(0, 8)} stop=${stop}`);
    } finally {
      args.signal.removeEventListener("abort", onAbort);
      // Cancelled turns spent tokens too, so this runs either way.
      const tokens = this.opts.usageDir ? await takeTurnUsage(this.opts.usageDir, id) : null;
      if (tokens) args.onEvent({ kind: "tokens", ...tokens });
    }
  }

  close(): Promise<void> {
    return this.conn.close();
  }
}
