-- 0024_glasses.sql
-- Recordings uploaded by the LabWeaver Glasses iOS app (contract:
-- docs/UPLOAD_API.md in lili-8477/labweaver-glasses), ported from v1
-- (claude-bioflow migrations 0014 + 0015) with the v1.1 imports. Rows only:
-- the bytes live on disk under RECORDINGS_ROOT/<owner>/<recording_id>/<name>.
--
-- recording_id is the app's localId, scoped by owner. source is 'stream'
-- (live fMP4 segments) or 'meta-ai' (an original imported from Photos,
-- uploaded in chunks and joined on complete).
--
-- State machine (glasses-mux.ts): uploading → complete → processed | mux_failed.
-- A mux_failed recording is retried by setting its state back to 'complete'.

CREATE TABLE glasses_recordings (
  owner         TEXT NOT NULL,
  recording_id  TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'stream' CHECK (source IN ('stream', 'meta-ai')),
  started_at    TIMESTAMPTZ NOT NULL,
  device        JSONB NOT NULL DEFAULT '{}'::jsonb,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  state         TEXT NOT NULL DEFAULT 'uploading'
                CHECK (state IN ('uploading', 'complete', 'processed', 'mux_failed')),
  manifest      JSONB,
  duration_ms   BIGINT,
  ended_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  mux_error     TEXT,
  processed_at  TIMESTAMPTZ,
  PRIMARY KEY (owner, recording_id)
);

CREATE INDEX glasses_recordings_to_mux_idx
  ON glasses_recordings (completed_at) WHERE state = 'complete';

-- One row per received file. A row exists only once its file is on disk
-- (inserted in the same transaction as the rename), so it is the upload ACK.
-- track/part/seq/start_ms/duration_ms are the phone's X-File-* headers; for a
-- chunk, part is the original's index and seq the chunk number.
CREATE TABLE glasses_files (
  owner         TEXT NOT NULL,
  recording_id  TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('init', 'media', 'events', 'manifest', 'chunk')),
  track         TEXT CHECK (track IN ('video', 'audio')),
  part          INT,
  seq           INT,
  start_ms      BIGINT,
  duration_ms   BIGINT,
  sha256        TEXT NOT NULL,
  bytes         BIGINT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, recording_id, name),
  FOREIGN KEY (owner, recording_id)
    REFERENCES glasses_recordings (owner, recording_id) ON DELETE CASCADE
);

-- One row per muxed part. start_ms/end_ms come from the manifest (ms since
-- recording start, host clock), so parts can be placed on the timeline.
CREATE TABLE glasses_parts (
  owner         TEXT NOT NULL,
  recording_id  TEXT NOT NULL,
  part          INT  NOT NULL,
  file          TEXT NOT NULL,
  bytes         BIGINT NOT NULL,
  duration_ms   BIGINT,
  width         INT,
  height        INT,
  has_audio     BOOLEAN NOT NULL,
  start_ms      BIGINT,
  end_ms        BIGINT,
  PRIMARY KEY (owner, recording_id, part),
  FOREIGN KEY (owner, recording_id)
    REFERENCES glasses_recordings (owner, recording_id) ON DELETE CASCADE
);
