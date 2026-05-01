-- TimescaleDB — usage telemetry, claude API cost tracking, schedule progress.

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS api_calls (
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  project_id     TEXT,
  service        TEXT NOT NULL,            -- claude | aps | solver
  endpoint       TEXT NOT NULL,
  duration_ms    INT,
  input_tokens   INT,
  output_tokens  INT,
  cache_read     INT,
  cache_write    INT,
  status         TEXT,
  error          TEXT
);
SELECT create_hypertable('api_calls', 'ts', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS api_calls_project_idx ON api_calls(project_id, ts DESC);

CREATE TABLE IF NOT EXISTS schedule_progress (
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  project_id     TEXT NOT NULL,
  activity       TEXT NOT NULL,
  pct_complete   NUMERIC NOT NULL,
  earned_value   NUMERIC,
  notes          TEXT
);
SELECT create_hypertable('schedule_progress', 'ts', if_not_exists => TRUE);
