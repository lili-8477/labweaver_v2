import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type {
  searchMemories,
  getMemory,
  timelineMemories,
  writeUserMemory,
  forgetMemory,
  getContext,
  updateMemory,
  restoreMemory,
  listMemories,
  getAuditTrail,
  getMetrics,
  listDirs,
  getDir,
  memoryTree,
  recordFeedback,
} from "./memory-repo.js";
import { InvalidDirError } from "./memory-dirs.js";
import { encodeProjectDir } from "./path-decode.js";
import type { proposeExperiences } from "./experience-promotion.js";
import type { writeDistillation } from "./distiller-repo.js";
import { EDGE_RELS, type linkMemories } from "./lineage-repo.js";
import type { buildBundle } from "./context-bundle.js";
import type { consolidate } from "./consolidate.js";
import { FACET_KEYS } from "./facets.js";
import { DistillationResult, PROMPT_VERSION } from "./distiller-prompts.js";

// DI seam: production wires real repo functions; tests pass vi.fn stubs. Pool
// and embedderClient travel as a bag so the same `repo.searchMemories` shape
// works whether the underlying impl needs them or not.
export interface MemoryApiDeps {
  pool:           Pool;
  embedderClient: { embedTexts: (texts: string[]) => Promise<number[][]> };
  // Cosine similarity at which a write is held back as a near-duplicate.
  mergeSimilarity: number;
  // Org managers (MEMORY_ORG_MANAGER); auto-promotion requests go to them.
  managers:        string[];
  // Per-user read clearance (MEMORY_CLEARANCE); default 'internal'.
  clearance?:      Record<string, string>;
  repo: {
    searchMemories:   typeof searchMemories;
    getMemory:        typeof getMemory;
    timelineMemories: typeof timelineMemories;
    writeUserMemory:  typeof writeUserMemory;
    forgetMemory:     typeof forgetMemory;
    getContext:       typeof getContext;
    updateMemory:     typeof updateMemory;
    restoreMemory:    typeof restoreMemory;
    listMemories:     typeof listMemories;
    getAuditTrail:    typeof getAuditTrail;
    getMetrics:       typeof getMetrics;
    listDirs:         typeof listDirs;
    getDir:           typeof getDir;
    memoryTree:       typeof memoryTree;
    recordFeedback:   typeof recordFeedback;
    proposeExperiences: typeof proposeExperiences;
    writeDistillation: typeof writeDistillation;
    linkMemories:     typeof linkMemories;
    buildBundle:      typeof buildBundle;
    consolidate:      typeof consolidate;
  };
}

// project_dir is tri-state: missing/undefined and explicit `null` both mean
// "no project filter". The repo layer normalises null → undefined / vice versa
// per its own conventions; we just pass the JSON shape through.
const SearchBody = z.object({
  username:    z.string().min(1),
  project_dir: z.string().nullable().optional(),
  // Raw container path (e.g. /workspace/pbmc3k), encoded server-side like
  // /memory/context; used by hooks that only know CLAUDE_PROJECT_DIR.
  project_path: z.string().min(1).optional(),
  query:       z.string().min(1),
  limit:       z.number().int().positive().max(100).optional(),
  types:       z.array(z.string()).optional(),
  since:       z.string().datetime().optional(),
  dirs:        z.array(z.string()).optional(),
  // Condition filters (spec §6.1): drop rows with a different value for a key.
  conditions:  z.record(z.enum(FACET_KEYS), z.array(z.string()).min(1)).optional(),
  strict:      z.boolean().optional(),
});

const TimelineQuery = z.object({
  username:    z.string().min(1),
  // Querystring → only `string | undefined` is reachable; nullability lives
  // at the JSON body layer (search/write).
  project_dir: z.string().optional(),
  since:       z.string().datetime().optional(),
  until:       z.string().datetime().optional(),
  // Querystrings arrive as strings; zod's `coerce.number` does the int parse.
  limit:       z.coerce.number().int().positive().max(500).optional(),
});

const WriteBody = z.object({
  username:    z.string().min(1),
  scope:       z.enum(["user", "project", "org"]),
  project_dir: z.string().nullable().optional(),
  type:        z.enum(["user", "feedback", "project", "reference"]),
  name:        z.string().min(1),
  description: z.string(),
  body:        z.string(),
  facets:      z.record(z.string(), z.array(z.string())).optional(),
  dir:         z.string().optional(),
  force_new:   z.boolean().optional(),
});

const ForgetBody = z.object({
  username:  z.string().min(1),
  memory_id: z.string().min(1),
});

const ContextQuery = z.object({
  username:      z.string().min(1),
  project_path:  z.string().min(1),
  budget_tokens: z.coerce.number().int().positive().max(100000).optional(),
});

const UpdateBody = z.object({
  actor:       z.string().min(1),
  name:        z.string().min(1),
  description: z.string(),
  body:        z.string().min(1),
  dir:         z.string().optional(),
  merge:       z.boolean().optional(),
});

const RestoreBody = z.object({ actor: z.string().min(1) });

// Querystring schema for GET /memory/list. Uses coerce.boolean/coerce.number
// for the same reason TimelineQuery does: querystrings arrive as strings.
// `type` arrives as repeated ?type=foo&type=bar → zod array of strings.
const ListQuery = z.object({
  username:        z.string().min(1),
  project_dir:     z.string().optional(),
  scope:           z.enum(['org', 'user', 'project']).optional(),
  type:            z.union([z.string(), z.array(z.string())]).transform((v) =>
    typeof v === 'string' ? [v] : v
  ).optional(),
  source:          z.enum(['user', 'distilled']).optional(),
  dir:             z.string().optional(),
  // Querystring booleans need explicit literal parsing — `z.coerce.boolean`
  // calls JS `Boolean(x)` which returns `true` for any non-empty string,
  // so `?include_deleted=false` would incorrectly include deleted rows.
  include_deleted: z.union([z.literal('true'), z.literal('false')]).optional()
                    .transform(v => v === 'true'),
  sort:            z.enum(['created', 'hit']).optional(),
  limit:           z.coerce.number().int().positive().max(200).optional(),
  cursor:          z.string().datetime().optional(),
});

const DirsQuery = z.object({
  username:    z.string().min(1),
  project_dir: z.string().optional(),
  all_projects: z.union([z.literal('true'), z.literal('false')]).optional()
                 .transform(v => v === 'true'),
  limit:       z.coerce.number().int().positive().max(200).optional(),
});

const TreeQuery = z.object({
  username: z.string().min(1),
  limit:    z.coerce.number().int().positive().max(5000).optional(),
});

const FeedbackBody = z.object({
  username:   z.string().min(1),
  memory_ids: z.array(z.string().uuid()).min(1).max(100),
  outcome:    z.enum(["success", "failure"]),
});

const AuditQuery = z.object({
  actor: z.string().min(1),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

// /memory/distill payload: the v2 distillation result (distiller-prompts.ts)
// plus the caller's identity.
const DistillBody = DistillationResult.and(z.object({
  username:          z.string().min(1),
  project_dir:       z.string().nullable().optional(),
  source_session_id: z.string().uuid().nullable().optional(),
}));

const BundleBody = z.object({
  username:     z.string().min(1),
  project_dir:  z.string().nullable().optional(),
  project_path: z.string().min(1).optional(),
  query:        z.string().min(1),
  conditions:   z.record(z.enum(FACET_KEYS), z.array(z.string()).min(1)).optional(),
  strict:       z.boolean().optional(),
  limit:        z.number().int().positive().max(30).optional(),
  budget_tokens: z.number().int().positive().max(8000).optional(),
});

const ConsolidateBody = z.object({
  actor:    z.string().min(1),
  username: z.string().min(1).optional(),
});

const LinkBody = z.object({
  actor:  z.string().min(1),
  src_id: z.string().uuid(),
  dst_id: z.string().uuid(),
  rel:    z.enum(EDGE_RELS),
  status: z.enum(["accepted", "rejected"]).optional(),
  note:   z.string().max(500).optional(),
});

export function buildApp(deps: MemoryApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const mergeCheck = { embedderClient: deps.embedderClient, similarity: deps.mergeSimilarity };
  const clearanceOf = (username: string) => deps.clearance?.[username] ?? "internal";

  // A write/update naming a directory outside the memory's scope is a client
  // error, not a 500.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof InvalidDirError) {
      reply.code(400).send({ error: err.message });
      return;
    }
    reply.send(err);
  });

  app.get("/healthz", async () => ({ ok: true }));

  // GET /memory/metrics — debug surface returning metrics across memory,
  // embedder_queue, and audit_log. No params, no auth (private docker network).
  app.get("/memory/metrics", async () => deps.repo.getMetrics(deps.pool));

  // POST /memory/search — hybrid retrieval (vector + FTS). Body validated by
  // SearchBody; ISO `since` is converted to Date at the boundary.
  app.post("/memory/search", async (req, reply) => {
    const parsed = SearchBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    const hits = await deps.repo.searchMemories({
      pool:           deps.pool,
      embedderClient: deps.embedderClient,
      username:       b.username,
      project_dir:    b.project_path ? encodeProjectDir(b.project_path) : (b.project_dir ?? null),
      query:          b.query,
      limit:          b.limit,
      types:          b.types,
      since:          b.since ? new Date(b.since) : undefined,
      dirs:           b.dirs,
      conditions:     b.conditions as Record<string, string[]> | undefined,
      strict:         b.strict,
      clearance:      clearanceOf(b.username),
    });
    return hits;
  });

  // GET /memory/timeline — registered BEFORE GET /memory/:id so fastify's
  // router matches the literal "timeline" segment first; otherwise the
  // dynamic `:id` route would swallow it.
  app.get("/memory/timeline", async (req, reply) => {
    const parsed = TimelineQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    const entries = await deps.repo.timelineMemories({
      pool:        deps.pool,
      username:    q.username,
      project_dir: q.project_dir,
      since:       q.since ? new Date(q.since) : undefined,
      until:       q.until ? new Date(q.until) : undefined,
      limit:       q.limit,
    });
    return entries;
  });

  // GET /memory/context — SessionStart directory index. Default
  // budget_tokens=800 (phase 3 gate); getContext trusts whatever arrives.
  app.get("/memory/context", async (req, reply) => {
    const parsed = ContextQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    const ctx = await deps.repo.getContext({
      pool:          deps.pool,
      username:      q.username,
      project_path:  q.project_path,
      budget_tokens: q.budget_tokens ?? 800,
    });
    return ctx;
  });

  // GET /memory/list — paginated listing with optional filters. Registered
  // BEFORE GET /memory/:id so fastify's router matches the literal "list"
  // segment before the dynamic :id wildcard.
  app.get("/memory/list", async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    return await deps.repo.listMemories({
      pool:            deps.pool,
      username:        q.username,
      project_dir:     q.project_dir ?? null,
      scope:           q.scope,
      type:            q.type,
      source:          q.source,
      dir:             q.dir,
      include_deleted: q.include_deleted,
      sort:            q.sort,
      limit:           q.limit,
      cursor:          q.cursor,
    });
  });

  // GET /memory/dirs — directories visible to the caller with their L0 and
  // entry counts. GET /memory/dirs/:dir_key — one directory's computed L1.
  // dir_key contains "/" so callers URL-encode it.
  app.get("/memory/dirs", async (req, reply) => {
    const parsed = DirsQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    return await deps.repo.listDirs({
      pool:         deps.pool,
      username:     q.username,
      project_dir:  q.project_dir ?? null,
      all_projects: q.all_projects,
    });
  });

  app.get<{ Params: { dir_key: string } }>("/memory/dirs/:dir_key", async (req, reply) => {
    const parsed = DirsQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    const dir = await deps.repo.getDir({
      pool:        deps.pool,
      username:    q.username,
      project_dir: q.project_dir ?? null,
      dir_key:     req.params.dir_key,
      limit:       q.limit,
    });
    if (dir === null) {
      reply.code(404);
      return { error: "directory not found" };
    }
    return dir;
  });

  // GET /memory/tree — every directory with its entries' usage counters and
  // the facet topics ranked by skill readiness.
  app.get("/memory/tree", async (req, reply) => {
    const parsed = TreeQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    return await deps.repo.memoryTree({ pool: deps.pool, ...parsed.data });
  });

  // POST /memory/feedback — outcome of a task that used these memories.
  app.post("/memory/feedback", async (req, reply) => {
    const parsed = FeedbackBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const { updated } = await deps.repo.recordFeedback({ pool: deps.pool, ...parsed.data });
    // A success may carry personal experience over the promotion threshold.
    const { proposed } = parsed.data.outcome === "success"
      ? await deps.repo.proposeExperiences({
          pool: deps.pool, managers: deps.managers, memory_ids: parsed.data.memory_ids,
        })
      : { proposed: [] as string[] };
    return { updated, proposed_for_org: proposed };
  });

  // POST /memory/write — /memorize-style user-authored memory. Returns
  // {memory_id: null} on dedup collision.
  app.post("/memory/write", async (req, reply) => {
    const parsed = WriteBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    return await deps.repo.writeUserMemory({
      pool:        deps.pool,
      username:    b.username,
      scope:       b.scope,
      project_dir: b.project_dir ?? null,
      type:        b.type,
      name:        b.name,
      description: b.description,
      body:        b.body,
      facets:      b.facets,
      dir:         b.dir,
      force_new:   b.force_new,
      merge:       mergeCheck,
    });
  });

  // POST /memory/distill — agent-driven on-demand distill (the only distill
  // path; auto-distill is off). The in-session agent supplies a v2 payload:
  // one run claim, 0..5 claims, 0..3 experiences. The response reports what
  // reconcile did, and lists `related` claims for the agent to label with
  // memory_link and `similar` experiences to fold in with memory_merge.
  app.post("/memory/distill", async (req, reply) => {
    const parsed = DistillBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    const outcome = await deps.repo.writeDistillation(deps.pool, {
      sessionMeta: {
        username:          b.username,
        project_dir:       b.project_dir ?? null,
        source_session_id: b.source_session_id ?? null,
      },
      result: { run: b.run, claims: b.claims, experiences: b.experiences },
      promptVersion: PROMPT_VERSION,
      merge:         mergeCheck,
    });
    return { ok: true, ...outcome };
  });

  // POST /memory/bundle — the context bundle for one task (MCP
  // memory_context, spec §6): filtered search plus conditions, evidence,
  // lineage, current versions and warnings, rendered as cited text. (GET
  // /memory/context stays the SessionStart directory index.)
  app.post("/memory/bundle", async (req, reply) => {
    const parsed = BundleBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    return await deps.repo.buildBundle({
      pool:           deps.pool,
      embedderClient: deps.embedderClient,
      username:       b.username,
      project_dir:    b.project_path ? encodeProjectDir(b.project_path) : (b.project_dir ?? null),
      query:          b.query,
      conditions:     b.conditions as Record<string, string[]> | undefined,
      strict:         b.strict,
      clearance:      clearanceOf(b.username),
      limit:          b.limit,
      budget_tokens:  b.budget_tokens,
    });
  });

  // POST /memory/consolidate — manager-only "System 2" pass (spec §7):
  // proposes SUPPORTS for replications, reports unlabeled same-condition
  // pairs and experiences built on superseded or retracted claims.
  app.post("/memory/consolidate", async (req, reply) => {
    const parsed = ConsolidateBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    if (!deps.managers.includes(parsed.data.actor)) {
      reply.code(403);
      return { error: "consolidation is manager-only" };
    }
    return await deps.repo.consolidate({
      pool: deps.pool, actor: parsed.data.actor, username: parsed.data.username,
      similarity: deps.mergeSimilarity,
    });
  });

  // POST /memory/link — write or reject a typed edge `src rel dst` (spec
  // §4.3). The agent labels `related` claims from /memory/distill with it;
  // RETRACTS / VALIDATED_BY / FAILED_TO_REPLICATE are for explicit user asks.
  app.post("/memory/link", async (req, reply) => {
    const parsed = LinkBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const r = await deps.repo.linkMemories({ pool: deps.pool, ...parsed.data });
    if (!r.ok && r.reason === "not_found") { reply.code(404); return { error: "memory not found" }; }
    if (!r.ok && r.reason === "forbidden") { reply.code(403); return { error: "src must be yours; dst must be yours (or org, for non-status edges)" }; }
    if (!r.ok && r.reason === "self")      { reply.code(400); return { error: "src and dst must differ" }; }
    return { ok: true };
  });

  // POST /memory/forget — soft-delete with username scoping; idempotent
  // (returns {ok:false} for already-deleted or wrong-owner ids).
  app.post("/memory/forget", async (req, reply) => {
    const parsed = ForgetBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    return await deps.repo.forgetMemory({
      pool:     deps.pool,
      username: b.username,
      memoryId: b.memory_id,
    });
  });

  // PUT /memory/:id — edit a user-authored memory's name/description/body.
  // Rejects distilled rows (403) and non-owner edits (403). Registered BEFORE
  // GET /memory/:id to match fastify's route-registration convention in this file.
  app.put<{ Params: { id: string } }>("/memory/:id", async (req, reply) => {
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation failed', issues: parsed.error.issues };
    }
    const r = await deps.repo.updateMemory({
      pool:        deps.pool,
      actor:       parsed.data.actor,
      memoryId:    req.params.id,
      name:        parsed.data.name,
      description: parsed.data.description,
      body:        parsed.data.body,
      dir:         parsed.data.dir,
      merge:       parsed.data.merge,
    });
    if (!r.ok && r.reason === 'not_found') { reply.code(404); return { error: 'memory not found' }; }
    if (!r.ok && r.reason === 'forbidden')  { reply.code(403); return { error: 'not the owner' }; }
    if (!r.ok && r.reason === 'distilled')  { reply.code(403); return { error: 'distilled memories are read-only' }; }
    if (!r.ok && r.reason === 'immutable')  { reply.code(409); return { error: 'claims are immutable; write a new claim and link it with SUPERSEDES or RETRACTS' }; }
    return { ok: true };
  });

  // POST /memory/:id/restore — undelete a soft-deleted memory. Owner-only.
  // 409 Conflict when the row is already live (not_deleted is a state mismatch,
  // not a validation problem). Registered before GET /memory/:id.
  app.post<{ Params: { id: string } }>("/memory/:id/restore", async (req, reply) => {
    const parsed = RestoreBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'validation failed', issues: parsed.error.issues }; }
    const r = await deps.repo.restoreMemory({ pool: deps.pool, actor: parsed.data.actor, memoryId: req.params.id });
    if (!r.ok && r.reason === 'not_found')   { reply.code(404); return { error: 'memory not found' }; }
    if (!r.ok && r.reason === 'forbidden')   { reply.code(403); return { error: 'not the owner' }; }
    if (!r.ok && r.reason === 'not_deleted') { reply.code(409); return { error: 'memory is not deleted' }; }
    return { ok: true };
  });

  // GET /memory/:id/audit — fetch audit trail for a memory. Owner-only.
  // Registered before GET /memory/:id so literal "/audit" segment takes precedence.
  app.get<{ Params: { id: string } }>("/memory/:id/audit", async (req, reply) => {
    const parsed = AuditQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation failed', issues: parsed.error.issues };
    }
    const q = parsed.data;
    const result = await deps.repo.getAuditTrail({
      pool:     deps.pool,
      actor:    q.actor,
      memoryId: req.params.id,
      limit:    q.limit,
    });
    if ('error' in result) {
      if (result.error === 'not_found') { reply.code(404); return { error: 'memory not found' }; }
      if (result.error === 'forbidden') { reply.code(403); return { error: 'not the owner' }; }
    }
    return result;
  });

  // GET /memory/:id — must be registered AFTER literal /memory/* routes
  // so fastify's radix tree prefers static segments over the wildcard.
  app.get<{ Params: { id: string } }>("/memory/:id", async (req, reply) => {
    const detail = await deps.repo.getMemory(deps.pool, req.params.id);
    if (detail === null) {
      reply.code(404);
      return { error: "memory not found" };
    }
    return detail;
  });

  return app;
}
