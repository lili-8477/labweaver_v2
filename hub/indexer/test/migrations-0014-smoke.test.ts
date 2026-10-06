import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/migrate.js';
import { defaultDir, type Scope } from '../src/memory-dirs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, '..', 'migrations');
const TYPES = ['user', 'feedback', 'project', 'reference', 'session_summary', 'observation'];
const OWNERS: Array<[Scope, string, string | null]> = [
  ['user', 'alice', null],
  ['project', 'alice', '-w-p'],
  ['org', '__org__', null],
];

describe('migration 0014 memory_dirs', () => {
  let pgc: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    pgc = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = new Pool({ connectionString: pgc.getConnectionUri() });

    // Apply everything before 0014, seed pre-existing rows, then apply 0014.
    const before = await mkdtemp(path.join(tmpdir(), 'mig-'));
    await cp(MIGRATIONS, before, {
      recursive: true,
      filter: (src) => !path.basename(src).startsWith('0014_'),
    });
    await runMigrations({ pool, migrationsDir: before, lockKey: 0xdeadbeefn });
    await rm(before, { recursive: true });

    let n = 0;
    for (const [, username, projectDir] of OWNERS) {
      for (const type of TYPES) {
        await pool.query(
          `INSERT INTO memories (memory_id, username, project_dir, type, source,
                                 name, description, body, content_hash)
           VALUES (gen_random_uuid(), $1, $2, $3, 'user', 'n', 'd', 'b', $4)`,
          [username, projectDir, type, Buffer.from([n++])],
        );
      }
    }
    await runMigrations({ pool, migrationsDir: MIGRATIONS, lockKey: 0xdeadbeefn });
  }, 120_000);
  afterAll(async () => { await pool.end(); await pgc.stop(); });

  it('seeds 9 directories, 3 per scope', async () => {
    const r = await pool.query(`SELECT scope, count(*)::int AS n FROM memory_dirs GROUP BY scope ORDER BY scope`);
    expect(r.rows).toEqual([
      { scope: 'org', n: 3 }, { scope: 'project', n: 3 }, { scope: 'user', n: 3 },
    ]);
  });

  it('backfills every (scope, type) exactly as defaultDir() does', async () => {
    const r = await pool.query<{ scope: Scope; type: string; dir_key: string }>(
      `SELECT scope, type, dir_key FROM memories`,
    );
    expect(r.rows).toHaveLength(OWNERS.length * TYPES.length);
    for (const row of r.rows) {
      expect(row.dir_key, `${row.scope}/${row.type}`).toBe(defaultDir(row.scope, row.type));
    }
  });

  it('requires a directory, and one in the memory\'s own scope', async () => {
    const insert = (dir: string | null) => pool.query(
      `INSERT INTO memories (memory_id, username, project_dir, type, source,
                             name, description, body, content_hash, dir_key)
       VALUES (gen_random_uuid(), 'alice', NULL, 'user', 'user', 'n', 'd', 'b', '\\xffff'::bytea, $1)`,
      [dir],
    );
    await expect(insert(null)).rejects.toThrow(/dir_key/);
    await expect(insert('project/decisions')).rejects.toThrow(/memories_dir_fk/);
    await expect(insert('user/nope')).rejects.toThrow(/memories_dir_fk/);
  });

  it('runs on pgvector >= 0.8 (search relies on hnsw.iterative_scan)', async () => {
    const r = await pool.query<{ v: string }>(`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`);
    const [major, minor] = r.rows[0]!.v.split('.').map(Number);
    expect(major! > 0 || minor! >= 8).toBe(true);
  });
});
