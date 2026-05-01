// Postgres adapter. Falls back to local JSON file persistence when DATABASE_URL
// is not set, so the server boots out-of-box without Docker.

const fs = require('fs');
const path = require('path');

const useDb = !!process.env.DATABASE_URL;
const PROJECTS_DIR = path.join(__dirname, '..', 'projects');

let _pool = null;
function pool() {
  if (!useDb) return null;
  if (_pool) return _pool;
  const { Pool } = require('pg');
  _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

// ----- file-mode helpers (dev fallback) -----
function fileLoad(id) {
  const p = path.join(PROJECTS_DIR, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function fileSave(p) {
  p.updated_at = new Date().toISOString();
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROJECTS_DIR, `${p.id}.json`), JSON.stringify(p, null, 2));
  return p;
}
function fileList() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json')).map(f => {
    const p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf8'));
    return { id: p.id, name: p.name, projectType: p.projectType, created_at: p.created_at };
  });
}

// ----- DB-mode helpers -----
async function dbLoad(id) {
  const c = pool();
  const proj = await c.query('SELECT * FROM projects WHERE id = $1', [id]);
  if (!proj.rows.length) return null;
  const r = proj.rows[0];
  const drawings = (await c.query('SELECT * FROM drawings WHERE project_id = $1 ORDER BY uploaded_at', [id])).rows;
  const elements = (await c.query('SELECT * FROM elements WHERE project_id = $1 ORDER BY created_at', [id])).rows;
  return {
    id: r.id,
    name: r.name,
    projectType: r.project_type,
    location: r.location,
    currency: r.currency,
    gfa: parseFloat(r.gfa),
    markup: parseFloat(r.markup),
    constraints: r.constraints,
    scenarios: r.scenarios,
    selected_scenario: r.selected_scenario,
    schedule: r.schedule,
    cashflow: r.cashflow,
    extraction_notes: r.extraction_notes,
    extraction_usage: r.extraction_usage,
    drawings: drawings.map(d => ({
      id: d.id, name: d.name, size: d.size_bytes, path: d.storage_key,
      status: d.status, urn: d.aps_urn, aps_stage: d.aps_stage,
      properties: d.properties, error: d.error, uploaded_at: d.uploaded_at,
    })),
    elements: elements.map(e => ({
      code: e.code, desc: e.description, discipline: e.discipline,
      section: e.section, qty: parseFloat(e.qty), unit: e.unit,
      rate: e.rate_override != null ? parseFloat(e.rate_override) : undefined,
      confidence: e.confidence != null ? parseFloat(e.confidence) : null,
      source: e.source, approved: e.approved,
    })),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function dbSave(p) {
  const c = pool();
  await c.query(`
    INSERT INTO projects (id, name, project_type, location, currency, gfa, markup,
                          constraints, scenarios, selected_scenario, schedule, cashflow,
                          extraction_notes, extraction_usage, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
    ON CONFLICT (id) DO UPDATE SET
      name=$2, project_type=$3, location=$4, currency=$5, gfa=$6, markup=$7,
      constraints=$8, scenarios=$9, selected_scenario=$10, schedule=$11,
      cashflow=$12, extraction_notes=$13, extraction_usage=$14, updated_at=now()
  `, [
    p.id, p.name, p.projectType, p.location, p.currency, p.gfa || 0, p.markup || 12,
    p.constraints || {}, p.scenarios || [], p.selected_scenario,
    p.schedule || null, p.cashflow || null, p.extraction_notes || null, p.extraction_usage || null,
  ]);
  // Drawings + elements upsert
  for (const d of (p.drawings || [])) {
    await c.query(`
      INSERT INTO drawings (id, project_id, name, size_bytes, storage_key, status, aps_urn, aps_stage, properties, error)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (id) DO UPDATE SET
        status=$6, aps_urn=$7, aps_stage=$8, properties=$9, error=$10
    `, [d.id, p.id, d.name, d.size, d.path, d.status, d.urn, d.aps_stage, d.properties, d.error]);
  }
  if (Array.isArray(p.elements)) {
    await c.query('DELETE FROM elements WHERE project_id = $1', [p.id]);
    for (const e of p.elements) {
      await c.query(`
        INSERT INTO elements (project_id, code, description, discipline, section, qty, unit, rate_override, confidence, source, approved)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [p.id, e.code, e.desc, e.discipline, e.section, e.qty || 0, e.unit, e.rate ?? null, e.confidence ?? null, e.source, e.approved !== false]);
    }
  }
  return p;
}

async function dbList() {
  const c = pool();
  const r = await c.query('SELECT id, name, project_type AS "projectType", created_at FROM projects ORDER BY updated_at DESC LIMIT 100');
  return r.rows;
}

// ----- public API -----
async function loadProject(id) {
  return useDb ? dbLoad(id) : fileLoad(id);
}
async function saveProject(p) {
  return useDb ? dbSave(p) : fileSave(p);
}
async function listProjects() {
  return useDb ? dbList() : fileList();
}

module.exports = { useDb, loadProject, saveProject, listProjects };
