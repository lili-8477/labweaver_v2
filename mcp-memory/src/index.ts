#!/usr/bin/env node
/**
 * labweaver-memory-mcp — stdio MCP server bridging Claude Code agents
 * to the labweaver memory-api HTTP service.
 *
 * Design notes:
 * - Thin bridge, no business logic. Each MCP tool is a 1-call HTTP proxy
 *   to memory-api. Validation and storage live in the API.
 * - `username` is fixed per-process from the env (one container = one user
 *   in the labweaver model); the agent never supplies it. This is what stops
 *   a curious agent from snooping another user's memories.
 * - org-scope writes are rejected at this layer because the only legitimate
 *   author is the platform admin running indexing, not an in-container
 *   agent. The API still accepts them for the indexer's own writes.
 * - HTTP errors (network, 4xx, 5xx) become MCP `isError: true` results so
 *   the calling agent sees them and can decide whether to retry, ask the
 *   user, or give up — surfacing as MCP transport errors would just kill
 *   the tool call.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ─── tool definitions ──────────────────────────────────────────────────
// JSON Schema (not zod) because that's what MCP clients consume verbatim
// from list_tools to render the tool surface to the model. Keep schemas
// permissive: validation is the API's job, and over-validating here would
// duplicate logic and silently mask new fields the API learns later.

export const toolDefinitions = [
  {
    name: "memory_search",
    description:
      "Search agent memories by hybrid (vector + FTS) ranking. Scoped to the current user; pass project_dir to narrow to one project.",
    inputSchema: {
      type: "object",
      properties: {
        query:       { type: "string", description: "Free-text query." },
        project_dir: { type: "string", description: "Encoded project dir (e.g. -home-alice-proj). Omit for cross-project search." },
        types:       { type: "array",  items: { type: "string" }, description: "Filter to memory types (user, feedback, project, reference)." },
        limit:       { type: "integer", minimum: 1, maximum: 100 },
        since:       { type: "string", description: "ISO-8601 cutoff; only memories created after are returned." },
        dirs:        { type: "array",  items: { type: "string" }, description: "Restrict to directories (dir_key, e.g. project/decisions); see memory_dir." },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_get",
    description: "Fetch a single memory by id. Returns null/404-error if not found.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "memory_timeline",
    description:
      "List memories in reverse-chronological order for the current user, optionally narrowed by project_dir/since/until.",
    inputSchema: {
      type: "object",
      properties: {
        project_dir: { type: "string" },
        since:       { type: "string", description: "ISO-8601" },
        until:       { type: "string", description: "ISO-8601" },
        limit:       { type: "integer", minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: "memory_dir",
    description:
      "Browse memory directories. Without dir: every directory visible to you with its one-line summary (L0) and entry count. With dir: that directory's overview (L1) — its top entries' names and one-line descriptions; read an entry's full body with memory_get. Directories: user/{preferences,experience,notes}, project/{entities,trajectories,decisions}, org/{entities,experience,references}.",
    inputSchema: {
      type: "object",
      properties: {
        dir:         { type: "string", description: "dir_key, e.g. project/decisions. Omit to list directories." },
        project_dir: { type: "string", description: "Encoded project dir; required to see project/* directories." },
        limit:       { type: "integer", minimum: 1, maximum: 200, description: "Max entries in the overview (default 20)." },
      },
    },
  },
  {
    name: "memory_tree",
    description:
      "Overview of how your memory is growing: every directory with its entry count, plus topics — memories sharing a pipeline/tool/dataset facet — with how often they were used and succeeded in tasks. Topics are ranked by skill readiness (0..1); `ready: true` means the topic has enough memories and proven successful uses that it is worth distilling into a skill. Use it to suggest building a skill, then read the topic's memory_ids with memory_get.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_write",
    description:
      "Author a new memory. scope='user' for personal memories, scope='project' (with project_dir) for project-scoped. scope='org' is admin-only and rejected here. If near-duplicates already exist in the target directory nothing is written and the result carries `similar` matches: merge into one with memory_merge, or re-send with force_new if it is genuinely distinct.",
    inputSchema: {
      type: "object",
      properties: {
        scope:       { type: "string", enum: ["user", "project"] },
        project_dir: { type: "string", description: "Required when scope='project'." },
        type:        { type: "string", enum: ["user", "feedback", "project", "reference"] },
        name:        { type: "string" },
        description: { type: "string" },
        body:        { type: "string" },
        facets:      { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
        dir:         { type: "string", description: "Directory in the same scope (e.g. project/decisions). Omit to file by type." },
        force_new:   { type: "boolean", description: "Write even if similar memories exist. Only after reviewing a `similar` response and deciding the new memory is distinct." },
      },
      required: ["scope", "type", "name", "description", "body"],
    },
  },
  {
    name: "memory_feedback",
    description:
      "Report how a task went that used memories. Call once at the end of a task in which memories (from the memory index, recall, memory_search or memory_get) actually informed your work, with those ids. Ranking learns from these outcomes; merely retrieving a memory does not count.",
    inputSchema: {
      type: "object",
      properties: {
        memory_ids: { type: "array", items: { type: "string" }, minItems: 1 },
        outcome:    { type: "string", enum: ["success", "failure"] },
      },
      required: ["memory_ids", "outcome"],
    },
  },
  {
    name: "memory_merge",
    description:
      "Fold new information into an existing memory you own (the merge half of merge-on-write). Use after memory_write or memory_distill_session returns `similar` matches: rewrite the closest match's name/description/body so it covers both old and new content, without dropping facts from either. Works on distilled memories too.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id:   { type: "string" },
        name:        { type: "string" },
        description: { type: "string" },
        body:        { type: "string", description: "The full merged body (replaces the old one)." },
      },
      required: ["memory_id", "name", "description", "body"],
    },
  },
  {
    name: "memory_forget",
    description:
      "Soft-delete a memory by id. The agent's username (from env) must own the memory; cross-user deletes are rejected at the API layer.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: { type: "string" },
      },
      required: ["memory_id"],
    },
  },
  {
    name: "memory_distill_session",
    description:
      "Pin the current conversation to long-term scientific memory. Call ONCE per /memory invocation. Send exactly one `run` (what this session did: subject, statement, conditions, inputs, parameters, outputs, QC, evidence), 0..5 `claims` (observations, results, interpretations, decisions; claim_kind 'feedback' for user preferences), and 0..3 `experiences` (reusable lessons; each must name when it applies and at least one boundary condition or failure mode). Claims are immutable. The server never overwrites an older claim: same-condition re-runs with a newer version supersede it, different conditions qualify it. The result lists `related` claims to label with memory_link and `similar` experiences to fold in with memory_merge.",
    inputSchema: {
      type: "object",
      properties: {
        project_dir:       { type: "string", description: "Encoded project dir (e.g. -home-alice-proj). Omit for user-scope distill." },
        source_session_id: { type: "string", description: "Session UUID, only if you know it." },
        run: {
          type: "object",
          description: "Exactly one run claim for this session.",
          properties: {
            subject:     { type: "string", maxLength: 120, description: "What was studied, e.g. 'PBMC3k clustering'." },
            statement:   { type: "string", maxLength: 800, description: "What was done and found, with the key numbers." },
            conditions:  { type: "object", description: "Condition facets, key → values. Keys: species, model, cell_line, tissue, sample, cohort, assay, protocol, protocol_version, reagent_lot, instrument, run_id, dose, timepoint, dataset, dataset_version, reference, pipeline, pipeline_version, code_version, gene, tool, file.", additionalProperties: { type: "array", items: { type: "string" } } },
            inputs:      { type: "array", items: { type: "string" } },
            parameters:  { type: "object" },
            outputs:     { type: "array", items: { type: "string" } },
            qc:          { type: "object", properties: { status: { type: "string", enum: ["pass", "warn", "fail", "unknown"] }, metrics: { type: "object" } }, required: ["status"] },
            evidence:    { type: "array", description: "Evidence URIs you saw: file:///abs/path, chpc://job/<id>, s3://…, https://…. Never invent one. Optional access_class: restricted or irb for controlled data.", items: { type: "object", properties: { uri: { type: "string" }, role: { type: "string", enum: ["source", "input", "output", "qc"] }, access_class: { type: "string", enum: ["public", "internal", "restricted", "irb"] } }, required: ["uri"] } },
            observed_at: { type: "string", description: "ISO-8601 time of the experiment or run, if not now." },
          },
          required: ["subject", "statement"],
        },
        claims: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              claim_kind:  { type: "string", enum: ["observation", "result", "interpretation", "decision", "feedback"] },
              subject:     { type: "string", maxLength: 120 },
              statement:   { type: "string", maxLength: 800 },
              conditions:  { type: "object", description: "Condition facets, key → values. Keys: species, model, cell_line, tissue, sample, cohort, assay, protocol, protocol_version, reagent_lot, instrument, run_id, dose, timepoint, dataset, dataset_version, reference, pipeline, pipeline_version, code_version, gene, tool, file.", additionalProperties: { type: "array", items: { type: "string" } } },
              confidence:  { type: "number", minimum: 0, maximum: 1 },
              qc:          { type: "object", properties: { status: { type: "string", enum: ["pass", "warn", "fail", "unknown"] }, metrics: { type: "object" } }, required: ["status"] },
              evidence:    { type: "array", description: "Evidence URIs you saw: file:///abs/path, chpc://job/<id>, s3://…, https://…. Never invent one. Optional access_class: restricted or irb for controlled data.", items: { type: "object", properties: { uri: { type: "string" }, role: { type: "string", enum: ["source", "input", "output", "qc"] }, access_class: { type: "string", enum: ["public", "internal", "restricted", "irb"] } }, required: ["uri"] } },
              observed_at: { type: "string" },
            },
            required: ["claim_kind", "subject", "statement"],
          },
        },
        experiences: {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              task:                { type: "string", maxLength: 200 },
              solution:            { type: "string", maxLength: 1200 },
              applicability:       { type: "array", items: { type: "string" }, minItems: 1 },
              boundary_conditions: { type: "array", items: { type: "string" } },
              failure_modes:       { type: "array", items: { type: "string" } },
              expected_qc:         { type: "object" },
              search_keys:         { type: "array", items: { type: "string" } },
              conditions:          { type: "object", description: "Condition facets, key → values. Keys: species, model, cell_line, tissue, sample, cohort, assay, protocol, protocol_version, reagent_lot, instrument, run_id, dose, timepoint, dataset, dataset_version, reference, pipeline, pipeline_version, code_version, gene, tool, file.", additionalProperties: { type: "array", items: { type: "string" } } },
              source:              { description: "'run' or the index of the claim it derives from.", oneOf: [{ type: "string", enum: ["run"] }, { type: "integer", minimum: 0 }] },
            },
            required: ["task", "solution", "applicability"],
          },
        },
      },
      required: ["run"],
    },
  },
  {
    name: "memory_context",
    description:
      "Get a cited context bundle for a task: relevant prior results and run records, reusable experience, current pipeline/protocol versions, lineage (superseded, qualified, contradicted), evidence links and warnings. Prefer it over memory_search before scientific work. Pass `conditions` to exclude memories from other conditions (e.g. another cell line); memories that do not state a condition are kept and flagged unless strict.",
    inputSchema: {
      type: "object",
      properties: {
        query:         { type: "string", description: "The task or question. Include exact IDs (genes, samples, lots, versions)." },
        project_dir:   { type: "string", description: "Encoded project dir. Omit for user scope." },
        conditions:    { type: "object", description: "Condition facets, key → values. Keys: species, model, cell_line, tissue, sample, cohort, assay, protocol, protocol_version, reagent_lot, instrument, run_id, dose, timepoint, dataset, dataset_version, reference, pipeline, pipeline_version, code_version, gene, tool, file.", additionalProperties: { type: "array", items: { type: "string" } } },
        strict:        { type: "boolean", description: "Also exclude memories that do not state a requested condition." },
        limit:         { type: "integer", minimum: 1, maximum: 30 },
        budget_tokens: { type: "integer", minimum: 100, maximum: 8000 },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_link",
    description:
      "Write a typed edge `src rel dst` between two memories. Use SUPPORTS or CONTRADICTS to label the `related` claims memory_distill_session returns, QUALIFIES when conditions explain a difference, SUPERSEDES when a newer claim replaces yours. RETRACTS, VALIDATED_BY and FAILED_TO_REPLICATE only when the user explicitly says so. status 'rejected' undoes an edge (a rejected SUPERSEDES or RETRACTS restores the old claim).",
    inputSchema: {
      type: "object",
      properties: {
        src_id: { type: "string" },
        dst_id: { type: "string" },
        rel:    { type: "string", enum: ["DERIVED_FROM", "SUPPORTS", "QUALIFIES", "CONTRADICTS", "SUPERSEDES", "RETRACTS", "VALIDATED_BY", "FAILED_TO_REPLICATE"] },
        status: { type: "string", enum: ["accepted", "rejected"] },
        note:   { type: "string", maxLength: 500 },
      },
      required: ["src_id", "dst_id", "rel"],
    },
  },
] as const;

// ─── deps & result types ───────────────────────────────────────────────

export interface ToolDeps {
  fetch:    typeof fetch;
  baseUrl:  string; // e.g. http://labweaver-indexer:8400
  username: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// Wrap a successful JSON payload in the shape MCP expects. The agent reads
// content[0].text — we stringify so structured data round-trips losslessly
// rather than getting flattened to "[object Object]".
function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

// Build an error result. We include status + body so the model can read why
// the call failed without us having to translate API errors to prose.
function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Shared HTTP→ToolResult unwrap. Anything non-2xx becomes an MCP error
// containing the raw body (which memory-api makes JSON-friendly already).
async function unwrap(res: Response, label: string): Promise<ToolResult> {
  const text = await res.text();
  if (!res.ok) {
    return fail(`${label} failed: HTTP ${res.status} ${res.statusText} — ${text}`);
  }
  // Pass through the API's JSON verbatim. If it isn't JSON (shouldn't happen
  // for these endpoints), wrap the raw text so the agent at least sees it.
  try {
    return ok(JSON.parse(text));
  } catch {
    return ok(text);
  }
}

// ─── tool handlers ─────────────────────────────────────────────────────
// Exported individually so tests can drive them without wiring the SDK
// stdio transport. Each catches network errors so the agent gets a
// structured tool-error rather than a transport-level crash.

export async function callMemorySearch(args: any, deps: ToolDeps): Promise<ToolResult> {
  // Build body explicitly: only forward fields the user supplied so that
  // optional API params remain optional on the wire (don't poison filters
  // with `undefined` keys after JSON.stringify drops them).
  const body: Record<string, unknown> = { username: deps.username, query: args?.query };
  if (args?.project_dir !== undefined) body.project_dir = args.project_dir;
  if (args?.limit       !== undefined) body.limit       = args.limit;
  if (args?.types       !== undefined) body.types       = args.types;
  if (args?.since       !== undefined) body.since       = args.since;
  if (args?.dirs        !== undefined) body.dirs        = args.dirs;
  try {
    const res = await deps.fetch(`${deps.baseUrl}/memory/search`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify(body),
    });
    return await unwrap(res, "memory_search");
  } catch (err) {
    return fail(`memory_search network error: ${(err as Error).message}`);
  }
}

export async function callMemoryGet(args: any, deps: ToolDeps): Promise<ToolResult> {
  // encodeURIComponent because memory ids are content hashes today but the
  // schema permits any string; defensive against future id changes.
  const id = encodeURIComponent(String(args?.id ?? ""));
  try {
    const res = await deps.fetch(`${deps.baseUrl}/memory/${id}`);
    return await unwrap(res, "memory_get");
  } catch (err) {
    return fail(`memory_get network error: ${(err as Error).message}`);
  }
}

export async function callMemoryTimeline(args: any, deps: ToolDeps): Promise<ToolResult> {
  const params = new URLSearchParams({ username: deps.username });
  if (args?.project_dir !== undefined) params.set("project_dir", String(args.project_dir));
  if (args?.since       !== undefined) params.set("since",       String(args.since));
  if (args?.until       !== undefined) params.set("until",       String(args.until));
  if (args?.limit       !== undefined) params.set("limit",       String(args.limit));
  try {
    const res = await deps.fetch(`${deps.baseUrl}/memory/timeline?${params.toString()}`);
    return await unwrap(res, "memory_timeline");
  } catch (err) {
    return fail(`memory_timeline network error: ${(err as Error).message}`);
  }
}

export async function callMemoryDir(args: any, deps: ToolDeps): Promise<ToolResult> {
  const params = new URLSearchParams({ username: deps.username });
  if (args?.project_dir !== undefined) params.set("project_dir", String(args.project_dir));
  if (args?.limit       !== undefined) params.set("limit",       String(args.limit));
  const path = args?.dir !== undefined
    ? `/memory/dirs/${encodeURIComponent(String(args.dir))}`
    : "/memory/dirs";
  try {
    const res = await deps.fetch(`${deps.baseUrl}${path}?${params.toString()}`);
    return await unwrap(res, "memory_dir");
  } catch (err) {
    return fail(`memory_dir network error: ${(err as Error).message}`);
  }
}

// The hub's tree also carries every memory leaf for the UI; the agent only
// needs the directory counts and the ranked topics.
export async function callMemoryTree(_args: any, deps: ToolDeps): Promise<ToolResult> {
  const params = new URLSearchParams({ username: deps.username });
  try {
    const res = await deps.fetch(`${deps.baseUrl}/memory/tree?${params.toString()}`);
    if (!res.ok) return await unwrap(res, "memory_tree");
    const tree = await res.json() as { dirs: unknown[]; memories: unknown[]; topics: unknown[]; thresholds: unknown };
    return ok({
      memories_total: tree.memories.length,
      dirs:           tree.dirs,
      topics:         tree.topics,
      thresholds:     tree.thresholds,
    });
  } catch (err) {
    return fail(`memory_tree network error: ${(err as Error).message}`);
  }
}

export async function callMemoryWrite(args: any, deps: ToolDeps): Promise<ToolResult> {
  // Hard reject org-scope BEFORE any HTTP traffic. The memory-api will
  // happily accept it (it's used by the indexer's own admin writes), so
  // this guard is the only thing keeping in-container agents from poisoning
  // org-wide memory.
  if (args?.scope === "org") {
    return fail(
      "memory_write rejected: org-scope writes are admin-only and not available from inside a user container.",
    );
  }
  const body: Record<string, unknown> = {
    username:    deps.username,
    scope:       args?.scope,
    type:        args?.type,
    name:        args?.name,
    description: args?.description,
    body:        args?.body,
  };
  if (args?.project_dir !== undefined) body.project_dir = args.project_dir;
  if (args?.facets      !== undefined) body.facets      = args.facets;
  if (args?.dir         !== undefined) body.dir         = args.dir;
  if (args?.force_new   !== undefined) body.force_new   = args.force_new;
  try {
    const res = await deps.fetch(`${deps.baseUrl}/memory/write`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify(body),
    });
    return await unwrap(res, "memory_write");
  } catch (err) {
    return fail(`memory_write network error: ${(err as Error).message}`);
  }
}

export async function callMemoryFeedback(args: any, deps: ToolDeps): Promise<ToolResult> {
  try {
    const res = await deps.fetch(`${deps.baseUrl}/memory/feedback`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ username: deps.username, memory_ids: args?.memory_ids, outcome: args?.outcome }),
    });
    return await unwrap(res, "memory_feedback");
  } catch (err) {
    return fail(`memory_feedback network error: ${(err as Error).message}`);
  }
}

export async function callMemoryMerge(args: any, deps: ToolDeps): Promise<ToolResult> {
  if (!args?.memory_id || typeof args.memory_id !== "string") {
    return fail("memory_merge: 'memory_id' is required");
  }
  try {
    const res = await deps.fetch(`${deps.baseUrl}/memory/${encodeURIComponent(args.memory_id)}`, {
      method:  "PUT",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({
        actor:       deps.username,
        name:        args.name,
        description: args.description,
        body:        args.body,
        merge:       true,
      }),
    });
    return await unwrap(res, "memory_merge");
  } catch (err) {
    return fail(`memory_merge network error: ${(err as Error).message}`);
  }
}

// POST helper for the scientific-memory tools: forward the agent's args
// (validation is the API's job) plus the fixed identity field.
async function postJson(path: string, body: Record<string, unknown>, label: string, deps: ToolDeps): Promise<ToolResult> {
  try {
    const res = await deps.fetch(`${deps.baseUrl}${path}`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify(body),
    });
    return await unwrap(res, label);
  } catch (err) {
    return fail(`${label} network error: ${(err as Error).message}`);
  }
}

export async function callMemoryDistillSession(args: any, deps: ToolDeps): Promise<ToolResult> {
  // Cheap up-front shape check so a malformed call gets a crisp error instead
  // of a 400 with a zod issue list. The API revalidates regardless.
  if (!args?.run || typeof args.run !== "object") {
    return fail("memory_distill_session: 'run' object is required (exactly one run claim per session)");
  }
  return postJson("/memory/distill", { ...args, username: deps.username }, "memory_distill_session", deps);
}

export async function callMemoryContext(args: any, deps: ToolDeps): Promise<ToolResult> {
  return postJson("/memory/bundle", { ...args, username: deps.username }, "memory_context", deps);
}

export async function callMemoryLink(args: any, deps: ToolDeps): Promise<ToolResult> {
  return postJson("/memory/link", { ...args, actor: deps.username }, "memory_link", deps);
}

export async function callMemoryForget(args: any, deps: ToolDeps): Promise<ToolResult> {
  // Validate the one required arg up front so we don't issue a POST that the
  // API would reject anyway — saves a round trip and gives the agent a
  // crisper error than the API's zod issue list.
  if (!args?.memory_id || typeof args.memory_id !== "string") {
    return fail("memory_forget: 'memory_id' is required");
  }
  try {
    const res = await deps.fetch(`${deps.baseUrl}/memory/forget`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ username: deps.username, memory_id: args.memory_id }),
    });
    return await unwrap(res, "memory_forget");
  } catch (err) {
    return fail(`memory_forget network error: ${(err as Error).message}`);
  }
}

// ─── stdio entrypoint ──────────────────────────────────────────────────
// Only run main() when invoked as a script. Test imports just want the
// handler functions and must not start a stdio server (which would hang
// vitest waiting for stdin).

async function main(): Promise<void> {
  const username = process.env.USERNAME ?? "";
  const baseUrl  = process.env.MEMORY_API_URL ?? "http://labweaver-indexer:8400";
  if (!username) {
    console.error("[labweaver-memory-mcp] USERNAME env var required");
    process.exit(1);
  }

  const deps: ToolDeps = { fetch, baseUrl, username };

  const server = new Server(
    { name: "labweaver-memory-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // Cast away the readonly-ness of `as const` for the SDK's mutable type.
    tools: toolDefinitions as unknown as Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    let result: ToolResult;
    switch (name) {
      case "memory_search":   result = await callMemorySearch(args, deps); break;
      case "memory_get":      result = await callMemoryGet(args, deps); break;
      case "memory_timeline": result = await callMemoryTimeline(args, deps); break;
      case "memory_dir":      result = await callMemoryDir(args, deps); break;
      case "memory_tree":     result = await callMemoryTree(args, deps); break;
      case "memory_write":    result = await callMemoryWrite(args, deps); break;
      case "memory_merge":    result = await callMemoryMerge(args, deps); break;
      case "memory_feedback": result = await callMemoryFeedback(args, deps); break;
      case "memory_forget":   result = await callMemoryForget(args, deps); break;
      case "memory_distill_session": result = await callMemoryDistillSession(args, deps); break;
      case "memory_context":  result = await callMemoryContext(args, deps); break;
      case "memory_link":     result = await callMemoryLink(args, deps); break;
      default:                result = fail(`unknown tool: ${name}`); break;
    }
    // SDK 1.x widened CallToolResult to include a "task" variant (long-running
    // tools); we only emit synchronous {content,isError} results, so cast.
    return result as unknown as { content: ToolResult["content"]; isError?: boolean };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs forever via stdio; no further code after connect.
}

// Run main() when this file is the program entrypoint. Using import.meta.url
// vs process.argv[1] is the canonical ESM check and works whether tsc emits
// the file as dist/index.js or it's run via tsx during dev.
const invokedDirect =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/labweaver-memory-mcp") === true;
if (invokedDirect) {
  main().catch((err) => {
    console.error("[labweaver-memory-mcp] fatal:", err);
    process.exit(1);
  });
}
