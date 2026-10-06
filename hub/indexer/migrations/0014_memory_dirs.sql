-- Memory directories (phase 1 of the hierarchical-memory plan).
--
-- A fixed catalogue of 9 directories, 3 per scope. Every memory lives in
-- exactly one directory. A "directory instance" is implicit: the owner's
-- (username, project_dir) plus dir_key, so no per-owner rows exist.
-- Directory L0 is the static `l0` line below; L1 is computed at read time
-- (memory-repo.ts getDir). `path` is reserved for future subdirectories.
CREATE TABLE memory_dirs (
  dir_key TEXT PRIMARY KEY,
  scope   TEXT NOT NULL CHECK (scope IN ('user', 'project', 'org')),
  path    TEXT NOT NULL,
  l0      TEXT NOT NULL,
  sort    INT  NOT NULL,
  UNIQUE (dir_key, scope)
);

INSERT INTO memory_dirs (dir_key, scope, path, l0, sort) VALUES
  ('project/entities',     'project', 'entities',     'Datasets, samples and pipelines used in this project',          10),
  ('project/trajectories', 'project', 'trajectories', 'Session summaries and execution trajectories for this project', 20),
  ('project/decisions',    'project', 'decisions',    'Decisions and findings, with dates and evidence',               30),
  ('org/entities',         'org',     'entities',     'Lab-standard entities: reference genomes, standard pipelines',  40),
  ('org/experience',       'org',     'experience',   'Reviewed, reusable lab practices',                              50),
  ('org/references',       'org',     'references',   'Papers, documentation and conventions',                         60),
  ('user/preferences',     'user',    'preferences',  'Working habits, preferences and corrections',                   70),
  ('user/experience',      'user',    'experience',   'Personal practices not yet reviewed for the lab',               80),
  ('user/notes',           'user',    'notes',        'Personal notes and references',                                 90);

-- Scope was previously re-derived by a CASE in every query; store it so the
-- directory FK below can require dir and memory to agree on scope.
ALTER TABLE memories ADD COLUMN scope TEXT GENERATED ALWAYS AS (
  CASE
    WHEN username = '__org__' THEN 'org'
    WHEN project_dir IS NULL  THEN 'user'
    ELSE 'project'
  END
) STORED;

ALTER TABLE memories ADD COLUMN dir_key TEXT;

-- Backfill. Must match defaultDir() in src/memory-dirs.ts.
UPDATE memories SET dir_key = scope || '/' || CASE scope
  WHEN 'project' THEN CASE type
    WHEN 'reference'       THEN 'entities'
    WHEN 'session_summary' THEN 'trajectories'
    ELSE 'decisions' END
  WHEN 'user' THEN CASE type
    WHEN 'user'        THEN 'preferences'
    WHEN 'feedback'    THEN 'preferences'
    WHEN 'observation' THEN 'experience'
    ELSE 'notes' END
  ELSE CASE type
    WHEN 'project'         THEN 'entities'
    WHEN 'reference'       THEN 'references'
    WHEN 'session_summary' THEN 'references'
    ELSE 'experience' END
END;

ALTER TABLE memories ALTER COLUMN dir_key SET NOT NULL;
ALTER TABLE memories ADD CONSTRAINT memories_dir_fk
  FOREIGN KEY (dir_key, scope) REFERENCES memory_dirs (dir_key, scope);

CREATE INDEX memories_dir_idx
  ON memories (username, project_dir, dir_key) WHERE deleted_at IS NULL;
