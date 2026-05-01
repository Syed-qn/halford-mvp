-- Halford workbench — relational schema.
-- Each project is a single-row aggregate that owns drawings, elements, scenarios.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keycloak_id   TEXT UNIQUE,
  email         TEXT NOT NULL,
  name          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  owner_id      UUID REFERENCES users(id),
  name          TEXT NOT NULL,
  project_type  TEXT NOT NULL,
  location      TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'AED',
  gfa           NUMERIC NOT NULL DEFAULT 0,
  markup        NUMERIC NOT NULL DEFAULT 12,
  constraints   JSONB NOT NULL DEFAULT '{}'::jsonb,
  scenarios     JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_scenario INT,
  schedule      JSONB,
  cashflow      JSONB,
  extraction_notes TEXT,
  extraction_usage JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_id);
CREATE INDEX IF NOT EXISTS projects_updated_idx ON projects(updated_at DESC);

CREATE TABLE IF NOT EXISTS drawings (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  size_bytes    BIGINT,
  storage_key   TEXT,                -- MinIO object key
  status        TEXT NOT NULL DEFAULT 'queued',  -- queued | processing | parsed | failed
  aps_urn       TEXT,
  aps_stage     TEXT,
  properties    TEXT,                 -- compressed property summary fed to Claude
  error         TEXT,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  parsed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS drawings_project_idx ON drawings(project_id);
CREATE INDEX IF NOT EXISTS drawings_status_idx ON drawings(status);

CREATE TABLE IF NOT EXISTS elements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  description   TEXT NOT NULL,
  discipline    TEXT,
  section       TEXT,
  qty           NUMERIC NOT NULL DEFAULT 0,
  unit          TEXT,
  rate_override NUMERIC,
  confidence    NUMERIC,
  source        TEXT,
  approved      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS elements_project_idx ON elements(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS elements_code_per_project_uq ON elements(project_id, code);

CREATE TABLE IF NOT EXISTS exports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,           -- boq | cost-plan | benchmark | audit | xer | cashflow
  storage_key   TEXT NOT NULL,           -- MinIO object key
  file_name     TEXT NOT NULL,
  size_bytes    BIGINT,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS exports_project_idx ON exports(project_id);
