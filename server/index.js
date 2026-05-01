// Halford AI QS & Planning Workbench — Express server.
//
// Wires:
//   /api/projects      — project CRUD
//   /api/projects/:id/upload    — multipart file upload to APS
//   /api/projects/:id/analyse   — kick off APS translate + Claude extraction
//   /api/projects/:id/elements  — get/edit elements
//   /api/projects/:id/price     — compute priced BoQ
//   /api/projects/:id/export/*  — generate output files
//   /api/projects/:id/optimize  — generate schedule scenarios via Claude

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuid } = require('uuid');

const aps = require('./services/aps');
const claude = require('./services/claude');
const pricing = require('./services/pricing');
const db = require('./services/db');
const storage = require('./services/storage');
const queue = require('./services/queue');
const auth = require('./services/auth');
const solver = require('./services/solver');
const scenarioEngine = require('./services/scenario-engine');
const boqExcel = require('./services/generators/boq-excel');
const costPlanPdf = require('./services/generators/cost-plan-pdf');
const benchmarkPdf = require('./services/generators/benchmark-pdf');
const auditPdf = require('./services/generators/audit-pdf');
const tenderPdf = require('./services/generators/tender-pdf');
const variationPdf = require('./services/generators/variation-pdf');
const p6xer = require('./services/generators/p6-xer');
const cashflowExcel = require('./services/generators/cashflow-excel');

const ROOT = __dirname;
// On Render set DATA_DIR=/var/data (mounted persistent disk). Locally it stays under server/.
const DATA_DIR     = process.env.DATA_DIR     || ROOT;
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(DATA_DIR, 'projects');
const UPLOADS_DIR  = process.env.UPLOADS_DIR  || path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR   = process.env.OUTPUT_DIR   || path.join(DATA_DIR, 'output');
[PROJECTS_DIR, UPLOADS_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const app = express();
// Render / any reverse-proxy host — trust the X-Forwarded-* headers so secure cookies
// and correct protocol detection work behind the platform's TLS terminator.
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
// Cookie parser for 3-legged OAuth session id (used by /api/aps/auth/* + Data Management)
let cookieParser; try { cookieParser = require('cookie-parser'); } catch (e) { /* lazy — only needed if BIM 360 used */ }
if (cookieParser) app.use(cookieParser());
app.use(auth.middleware());

// Health check endpoint — Render / Kubernetes / load balancers probe this.
app.get('/healthz', (req, res) => res.json({
  ok:        true,
  service:   'halford-ai-qs-workbench',
  version:   require('./package.json').version,
  timestamp: new Date().toISOString(),
}));

// Root → main app HTML. The single-file UI lives one directory up
// (path resolved by express.static below).
app.get('/', (req, res) => res.redirect(302, '/halford_ai_qs_workbench.html'));
// Force-download output files (don't let the browser try to render xlsx/pdf inline)
app.use('/output', express.static(OUTPUT_DIR, {
  setHeaders: (res, filePath) => {
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
  },
}));
// Serve the workbench UI at the root.
app.use(express.static(path.join(ROOT, '..')));

// ---------------- persistence helpers ----------------
async function loadProject(id) { return db.loadProject(id); }
async function saveProject(p) { return db.saveProject(p); }

// Boot the BullMQ worker if Redis is configured.
queue.startWorker({
  load: id => db.loadProject(id),
  write: p => db.saveProject(p),
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOADS_DIR, req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// ---------------- project CRUD ----------------
app.post('/api/projects', async (req, res) => {
  const id = uuid().slice(0, 8);
  const p = {
    id,
    name: req.body.name || 'Untitled project',
    projectType: req.body.projectType || 'Residential — high rise',
    location: req.body.location || 'Dubai, UAE',
    currency: req.body.currency || 'AED',
    drawings: [],
    elements: [],
    gfa: 0,
    markup: 12,
    constraints: {},
    scenarios: [],
    selected_scenario: null,
    created_at: new Date().toISOString(),
  };
  await saveProject(p);
  res.json(p);
});

app.get('/api/projects/:id', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  res.json(p);
});

app.patch('/api/projects/:id', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  Object.assign(p, req.body);
  await saveProject(p);
  res.json(p);
});

app.get('/api/projects', async (req, res) => {
  res.json(await db.listProjects());
});

// ---------------- rate library ----------------
app.get('/api/rates', async (req, res) => {
  res.json(claude.loadRates());
});

// Resources matched to project's approved elements
app.get('/api/projects/:id/resources', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const rates = claude.loadRates();
  const resources = rates.resources || {};
  const elements = rates.elements || {};

  // Crew → resource code mapping. LAB-007 (engineer) + LAB-008 (supervisor) on every crew.
  // LAB-007 (engineer), LAB-008 (supervisor), LAB-019 (HSE), LAB-020 (PM) on every crew.
  const baseLabour = ['LAB-007', 'LAB-008', 'LAB-019', 'LAB-020'];
  const crewResourceMap = {
    piling:         [...baseLabour, 'LAB-001', 'LAB-012', 'LAB-021', 'PLT-008', 'PLT-006', 'PLT-010', 'PLT-016', 'MAT-002', 'MAT-004'],
    concrete:       [...baseLabour, 'LAB-001', 'LAB-003', 'LAB-021', 'PLT-003', 'PLT-010', 'PLT-013', 'MAT-001', 'MAT-002', 'MAT-003', 'MAT-004', 'MAT-010', 'MAT-015', 'MAT-016', 'MAT-017'],
    steel:          [...baseLabour, 'LAB-004', 'LAB-017', 'LAB-018', 'PLT-002', 'PLT-004', 'PLT-014', 'MAT-005'],
    block:          [...baseLabour, 'LAB-001', 'LAB-002', 'LAB-021', 'PLT-015', 'MAT-006', 'MAT-010', 'MAT-015'],
    facade:         [...baseLabour, 'LAB-006', 'LAB-013', 'PLT-005', 'PLT-017', 'MAT-023', 'MAT-024'],
    mep:            [...baseLabour, 'LAB-005', 'LAB-014', 'LAB-015', 'LAB-016', 'PLT-014', 'PLT-016', 'MAT-011', 'MAT-012', 'MAT-021', 'MAT-022'],
    finishes:       [...baseLabour, 'LAB-001', 'LAB-002', 'LAB-003', 'LAB-010', 'LAB-011', 'LAB-021', 'MAT-007', 'MAT-008', 'MAT-010', 'MAT-013', 'MAT-018', 'MAT-019', 'MAT-020', 'MAT-025'],
    waterproofing:  [...baseLabour, 'LAB-009', 'MAT-009', 'MAT-026'],
    earthworks:     [...baseLabour, 'LAB-001', 'LAB-021', 'PLT-001', 'PLT-011', 'PLT-006', 'PLT-007', 'PLT-010', 'PLT-012', 'MAT-014', 'MAT-017'],
    civils:         [...baseLabour, 'LAB-001', 'LAB-002', 'LAB-018', 'PLT-001', 'PLT-011', 'PLT-006', 'PLT-003', 'PLT-009', 'PLT-012', 'MAT-001', 'MAT-014', 'MAT-015'],
  };

  // Section-based fallback labour_hrs for Claude-minted codes not in the rate library
  const sectionLabourFallback = {
    'Preliminaries': 8, 'Substructure': 4, 'Frame': 2, 'Roof': 0.5,
    'Envelope': 1.5, 'Finishes': 1.0, 'MEP': 1.0, 'External': 0.8,
  };

  // Determine which resource codes are needed based on approved elements
  const approvedElements = (p.elements || []).filter(e => e.approved !== false);
  const usedCodes = new Set();
  let totalLabourHrs = 0;

  if (approvedElements.length) {
    for (const el of approvedElements) {
      const elemDef = elements[el.code] || {};
      const crew = elemDef.crew || '';
      (crewResourceMap[crew] || []).forEach(c => usedCodes.add(c));
      const lhrPerUnit = elemDef.labour_hrs ?? sectionLabourFallback[el.section] ?? 1;
      if (lhrPerUnit && el.qty) totalLabourHrs += lhrPerUnit * el.qty;
    }
  }

  const result = Object.values(resources).map(r => ({
    ...r,
    used: usedCodes.size ? usedCodes.has(r.code) : true, // show all if no elements yet
    // r.source already comes from rates.json (per-resource attribution); do not overwrite
  }));

  res.json({
    resources:        result,
    total_labour_hrs: Math.round(totalLabourHrs),
    used_count:       usedCodes.size,
    meta:             rates._meta,
  });
});

// ---------------- file upload ----------------
app.post('/api/projects/:id/upload', upload.array('files', 50), async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });

  const newDrawings = (req.files || []).map(f => ({
    id: uuid().slice(0, 8),
    name: f.originalname,
    path: f.path,
    size: f.size,
    status: 'queued',
    uploaded_at: new Date().toISOString(),
  }));
  p.drawings.push(...newDrawings);
  await saveProject(p);
  res.json({ drawings: p.drawings });

  // Kick off APS processing in the background.
  (async () => {
    for (const d of newDrawings) {
      try {
        d.status = 'processing';
        await saveProject(p);
        const result = await aps.processDrawing(p.id, d.name, d.path, async (stage) => {
          d.aps_stage = stage;
          await saveProject(p);
        });
        d.urn        = result.urn;
        d.properties = claude.compressProperties(result.properties, d.name);
        d.viewables  = result.viewables || [];
        d.thumbnail  = result.thumbnail || null;
        d.pdb_survey = result.pdb_survey || null;
        d.element_count = (result.properties || []).reduce((s, v) => s + (v.count || 0), 0);

        // PDF drawings have no APS geometry — extract text via PyMuPDF / pdf-parse
        if (result.note === 'no_property_database') {
          try {
            const pdfData = await solver.parsePdf(d.path);
            if (pdfData && pdfData.pages && pdfData.pages.length) {
              d.pdf_text = pdfData.pages.map(pg => pg.text_excerpt || '').join('\n---\n').slice(0, 4000);
              d.title_block = pdfData.pages.map(pg => pg.title_block || '').filter(Boolean).join('\n').slice(0, 600);
              console.log(`[upload] PDF text extracted for ${d.name}: ${d.pdf_text.length} chars`);
            }
          } catch (e) {
            console.warn(`[upload] PDF text extraction failed for ${d.name}:`, e.message);
          }
        }

        d.status = 'parsed';
        await saveProject(p);
      } catch (e) {
        d.status = 'failed';
        d.error = e.message;
        console.error(`[upload] ${d.name} failed:`, e.message);
        await saveProject(p);
      }
    }
  })();
});

// ---------------- analyse (Claude extraction) ----------------
app.post('/api/projects/:id/analyse', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });

  const ready = (p.drawings || []).filter(d => d.status === 'parsed' && d.properties);
  let result;
  try {
    if (ready.length) {
      // Pull every 2D sheet as a high-res image for DWG/IFC/RVT drawings, and load PDF buffers
      // for PDF drawings. Claude reads these directly via vision/document blocks.
      const drawingsWithVisuals = await Promise.all(ready.map(async (d) => {
        let pdf_buffer = null;
        let sheets = [];
        // PDF: send the file directly to Claude as a document
        if (d.path && /\.pdf$/i.test(d.name) && fs.existsSync(d.path)) {
          try {
            const buf = fs.readFileSync(d.path);
            if (buf.length <= 30 * 1024 * 1024) pdf_buffer = buf;
            else console.warn(`[analyse] PDF ${d.name} is ${(buf.length / 1024 / 1024).toFixed(1)}MB — too large to attach`);
          } catch (e) { console.warn(`[analyse] failed to read PDF ${d.name}: ${e.message}`); }
        }
        // DWG/IFC/RVT: render every 2D sheet (floor plans, sections, schedules, elevations)
        // at 1024×1024 — these carry dimensioned data Claude can read with vision.
        if (!pdf_buffer && d.urn && d.viewables && d.viewables.length) {
          try {
            sheets = await aps.renderSheets(d.urn, d.viewables, 20);
            console.log(`[analyse]   ${d.name}: rendered ${sheets.length} sheet(s) for vision`);
          } catch (e) { console.warn(`[analyse] sheet render failed for ${d.name}: ${e.message}`); }
        }
        return {
          name:        d.name,
          summary:     d.properties,
          pdf_text:    d.pdf_text || null,
          title_block: d.title_block || null,
          sheets,
          pdf_buffer,
        };
      }));
      const totalSheets = drawingsWithVisuals.reduce((s, d) => s + (d.sheets?.length || 0) + (d.pdf_buffer ? 1 : 0), 0);
      console.log(`[analyse] sending ${ready.length} drawing(s) to Claude with ${totalSheets} visual block(s)`);
      result = await claude.extractElements({
        projectName: p.name,
        projectType: p.projectType,
        location: p.location,
        drawings: drawingsWithVisuals,
      });
    } else {
      // Fallback: infer from drawing names alone.
      const names = (p.drawings || []).map(d => d.name);
      if (!names.length) return res.status(400).json({ error: 'no drawings uploaded' });
      result = await claude.extractElementsFromNames({
        projectName: p.name,
        projectType: p.projectType,
        location: p.location,
        drawingNames: names,
      });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Claude extraction failed: ' + e.message });
  }

  // Aggregate duplicate codes — same element from multiple drawings → sum qty
  const merged = {};
  for (const e of (result.elements || [])) {
    if (merged[e.code]) {
      merged[e.code].qty += e.qty;
      merged[e.code].confidence = Math.round((merged[e.code].confidence + e.confidence) / 2);
      if (!merged[e.code].source.includes(e.source)) merged[e.code].source += ', ' + e.source;
    } else {
      merged[e.code] = { ...e };
    }
  }
  p.elements = Object.values(merged).map(e => ({ ...e, approved: true }));
  p.gfa = result.gfa || 0;
  p.extraction_notes = result.notes || '';
  p.extraction_usage = result.usage;
  await saveProject(p);
  res.json({ elements: p.elements, gfa: p.gfa, notes: p.extraction_notes, cache_read: result.cache_read, cache_write: result.cache_write });
});

// ---------------- elements review ----------------
app.get('/api/projects/:id/elements', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  res.json({ elements: p.elements || [], gfa: p.gfa || 0, drawings: p.drawings || [] });
});

app.patch('/api/projects/:id/elements', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  // Accept full elements array OR sparse updates by code.
  if (Array.isArray(req.body.elements)) {
    p.elements = req.body.elements;
  } else if (req.body.update) {
    for (const u of req.body.update) {
      const el = p.elements.find(e => e.code === u.code);
      if (el) Object.assign(el, u);
    }
  }
  await saveProject(p);
  res.json({ elements: p.elements });
});

// ---------------- pricing ----------------
app.get('/api/projects/:id/boq', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (req.query.markup) p.markup = parseFloat(req.query.markup);
  const boq = pricing.computeBoQ(p);
  res.json(boq);
});

app.patch('/api/projects/:id/pricing', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (typeof req.body.markup === 'number') p.markup = req.body.markup;
  if (Array.isArray(req.body.rates)) {
    for (const u of req.body.rates) {
      const el = p.elements.find(e => e.code === u.code);
      if (el && typeof u.rate === 'number') el.rate = u.rate;
    }
  }
  await saveProject(p);
  res.json(pricing.computeBoQ(p));
});

// ---------------- exports ----------------
function ensureProjectOutput(id) {
  const dir = path.join(OUTPUT_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
async function publishOutput(projectId, fileName, localPath) {
  const r = await storage.putOutput(projectId, fileName, localPath);
  return r.public_url || `/output/${projectId}/${fileName}`;
}

app.post('/api/projects/:id/export/boq', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const boq = pricing.computeBoQ(p);
  const dir = ensureProjectOutput(p.id);
  const file = `Halford_${p.id}_BoQ.xlsx`;
  await boqExcel.generate(p, boq, path.join(dir, file));
  const url = await publishOutput(p.id, file, path.join(dir, file));
  res.json({ url, file, total: boq.total });
});

app.post('/api/projects/:id/export/cost-plan', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const boq = pricing.computeBoQ(p);
  const dir = ensureProjectOutput(p.id);
  const file = `Halford_${p.id}_CostPlan.pdf`;
  await costPlanPdf.generate(p, boq, path.join(dir, file));
  const url = await publishOutput(p.id, file, path.join(dir, file));
  res.json({ url, file });
});

app.post('/api/projects/:id/export/benchmark', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const boq = pricing.computeBoQ(p);
  const bench = pricing.benchmark(p, boq);
  const dir = ensureProjectOutput(p.id);
  const file = `Halford_${p.id}_Benchmark.pdf`;
  await benchmarkPdf.generate(p, boq, bench, path.join(dir, file));
  const url = await publishOutput(p.id, file, path.join(dir, file));
  res.json({ url, file, benchmark: bench });
});

app.post('/api/projects/:id/export/audit', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const boq = pricing.computeBoQ(p);
  const dir = ensureProjectOutput(p.id);
  const file = `Halford_${p.id}_Audit.pdf`;
  await auditPdf.generate(p, boq, path.join(dir, file));
  const url = await publishOutput(p.id, file, path.join(dir, file));
  res.json({ url, file });
});

app.post('/api/projects/:id/export/tender', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const boq = pricing.computeBoQ(p);
  const dir = ensureProjectOutput(p.id);
  const file = `Halford_${p.id}_TenderReview.pdf`;
  await tenderPdf.generate(p, boq, path.join(dir, file));
  const url = await publishOutput(p.id, file, path.join(dir, file));
  res.json({ url, file });
});

app.post('/api/projects/:id/export/variation', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const boq = pricing.computeBoQ(p);
  const dir = ensureProjectOutput(p.id);
  const file = `Halford_${p.id}_Variation.pdf`;
  await variationPdf.generate(p, boq, path.join(dir, file));
  const url = await publishOutput(p.id, file, path.join(dir, file));
  res.json({ url, file });
});

app.post('/api/projects/:id/export/xer', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const boq = pricing.computeBoQ(p);
  const schedule = p.schedule || pricing.buildSchedule(p, boq);
  p.schedule = schedule;
  await saveProject(p);
  const dir = ensureProjectOutput(p.id);
  const file = `Halford_${p.id}_Schedule.xer`;
  p6xer.generate(p, schedule, boq, path.join(dir, file));
  const url = await publishOutput(p.id, file, path.join(dir, file));
  res.json({ url, file, schedule });
});

app.post('/api/projects/:id/export/cashflow', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const boq = pricing.computeBoQ(p);
  const schedule = p.schedule || pricing.buildSchedule(p, boq);
  const cashflow = pricing.buildCashflow(p, boq, schedule);
  p.schedule = schedule;
  p.cashflow = cashflow;
  await saveProject(p);
  const dir = ensureProjectOutput(p.id);
  const file = `Halford_${p.id}_CashFlow.xlsx`;
  await cashflowExcel.generate(p, boq, schedule, cashflow, path.join(dir, file));
  const url = await publishOutput(p.id, file, path.join(dir, file));
  res.json({ url, file, cashflow });
});

// ---------------- scheduling ----------------
app.patch('/api/projects/:id/constraints', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  p.constraints = { ...(p.constraints || {}), ...req.body };
  await saveProject(p);
  res.json({ constraints: p.constraints });
});

app.post('/api/projects/:id/optimize', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const boq          = pricing.computeBoQ(p);
  const baseSchedule = pricing.buildSchedule(p, boq);

  // Time-cost trade-off scenarios. See server/services/scenario-engine.js for math.
  const scenarios = scenarioEngine.computeAllScenarios(p, boq);

  p.scenarios = scenarios;
  p.schedule  = baseSchedule;
  await saveProject(p);
  res.json({
    scenarios,
    base_schedule: baseSchedule,
    method: 'time-cost trade-off (TCT) — direct + indirect + risk reserve, calibrated to UAE Q1 2025 market',
  });
});

app.post('/api/projects/:id/schedule', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (typeof req.body.scenario_index === 'number') p.selected_scenario = req.body.scenario_index;
  const boq = pricing.computeBoQ(p);
  const schedule = pricing.buildSchedule(p, boq);
  const cashflow = pricing.buildCashflow(p, boq, schedule);
  p.schedule = schedule;
  p.cashflow = cashflow;
  await saveProject(p);
  res.json({ schedule, cashflow, boq });
});

app.get('/api/projects/:id/schedule', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const boq = pricing.computeBoQ(p);
  const schedule = p.schedule || pricing.buildSchedule(p, boq);
  const cashflow = p.cashflow || pricing.buildCashflow(p, boq, schedule);
  res.json({ schedule, cashflow });
});

// ---------------- tender review (contractor BoQ vs estimate) ----------------
app.post('/api/projects/:id/tender-review', upload.single('file'), async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  if (!req.file) return res.status(400).json({ error: 'contractor BoQ file required' });
  // Stub for now: just acknowledge — full diff would need its own Claude prompt.
  res.json({ uploaded: req.file.originalname, status: 'queued', note: 'Tender review feature requires contractor BoQ parsing — endpoint stubbed.' });
});

// ============================================================================
// APS — full API surface
// ============================================================================

// ---- Viewer SDK: read-only token for embedded viewer ----
app.get('/api/aps/viewer-token', async (req, res) => {
  try {
    const t = await aps.getViewerToken();
    res.json(t);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Get a drawing's URN so the viewer can load it ----
app.get('/api/projects/:id/drawings/:idx/urn', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const d = (p.drawings || [])[parseInt(req.params.idx, 10)];
  if (!d || !d.urn) return res.status(404).json({ error: 'drawing has no URN (still translating?)' });
  res.json({ urn: d.urn, name: d.name, viewables: d.viewables || [], thumbnail: d.thumbnail || null });
});

// ---- PDB SQLite: run a quantity survey ----
app.get('/api/projects/:id/drawings/:idx/pdb-survey', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const d = (p.drawings || [])[parseInt(req.params.idx, 10)];
  if (!d || !d.urn) return res.status(404).json({ error: 'drawing not translated' });
  try {
    const survey = await aps.pdbQuantitySurvey(d.urn);
    res.json({ drawing: d.name, survey });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- PDB SQLite: arbitrary read-only SQL (admin tool) ----
app.post('/api/projects/:id/drawings/:idx/pdb-query', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const d = (p.drawings || [])[parseInt(req.params.idx, 10)];
  if (!d || !d.urn) return res.status(404).json({ error: 'drawing not translated' });
  const sql = req.body?.sql;
  if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'sql string required' });
  // Hard-block any non-SELECT — PDB is read-only.
  if (!/^\s*SELECT\b/i.test(sql.trim())) return res.status(400).json({ error: 'only SELECT permitted' });
  try {
    const rows = await aps.queryPDB(d.urn, sql, req.body.params || []);
    res.json({ rows: rows.slice(0, 5000), truncated: rows.length > 5000 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// 3-LEGGED OAUTH — sign in with Autodesk ID, then access BIM 360 / ACC
// ============================================================================

function sessionId(req, res) {
  let id = req.cookies?.['halford-aps-sid'];
  if (!id) {
    id = uuid();
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('halford-aps-sid', id, {
      httpOnly: true,
      sameSite: 'lax',
      secure:   isProd,                // require HTTPS in prod (Render terminates TLS)
      maxAge:   30 * 24 * 60 * 60 * 1000,
    });
  }
  return id;
}

app.get('/api/aps/auth/login', (req, res) => {
  const sid = sessionId(req, res);
  const redirect = `${req.protocol}://${req.get('host')}/api/aps/auth/callback`;
  const url = aps.buildAuthorizeUrl(redirect, sid);
  res.redirect(url);
});

app.get('/api/aps/auth/callback', async (req, res) => {
  const sid = sessionId(req, res);
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing authorization code');
  try {
    const redirect = `${req.protocol}://${req.get('host')}/api/aps/auth/callback`;
    const tok = await aps.exchangeCodeForToken(code, redirect);
    aps.storeUserToken(sid, tok);
    res.send('<!doctype html><html><body style="font:14px/1.4 -apple-system,sans-serif;padding:2rem;"><h2>Signed in to Autodesk</h2><p>You may close this window and return to Halford.</p><script>setTimeout(()=>window.close(),1500);</script></body></html>');
  } catch (e) {
    res.status(500).send('OAuth callback failed: ' + e.message);
  }
});

app.get('/api/aps/auth/status', async (req, res) => {
  const sid = sessionId(req, res);
  const tok = await aps.getUserToken(sid);
  res.json({ signed_in: !!tok });
});

app.post('/api/aps/auth/logout', (req, res) => {
  res.clearCookie('halford-aps-sid');
  res.json({ ok: true });
});

// ============================================================================
// DATA MANAGEMENT — browse BIM 360 / ACC and import drawings
// ============================================================================

async function requireUserToken(req, res) {
  const sid = sessionId(req, res);
  const tok = await aps.getUserToken(sid);
  if (!tok) {
    res.status(401).json({ error: 'not signed in', login: '/api/aps/auth/login' });
    return null;
  }
  return tok;
}

app.get('/api/aps/hubs', async (req, res) => {
  const tok = await requireUserToken(req, res); if (!tok) return;
  try { res.json({ hubs: await aps.listHubs(tok) }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/aps/hubs/:hubId/projects', async (req, res) => {
  const tok = await requireUserToken(req, res); if (!tok) return;
  try { res.json({ projects: await aps.listProjects(tok, req.params.hubId) }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/aps/hubs/:hubId/projects/:projectId/folders', async (req, res) => {
  const tok = await requireUserToken(req, res); if (!tok) return;
  try { res.json({ folders: await aps.listTopFolders(tok, req.params.hubId, req.params.projectId) }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/aps/projects/:projectId/folders/:folderId/contents', async (req, res) => {
  const tok = await requireUserToken(req, res); if (!tok) return;
  try { res.json({ contents: await aps.listFolderContents(tok, req.params.projectId, req.params.folderId) }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import a BIM 360 / ACC item into a Halford project. Triggers translation directly
// against BIM 360's storage URN — no byte copy required.
app.post('/api/projects/:id/import-bim360', async (req, res) => {
  const p = await loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const tok = await requireUserToken(req, res); if (!tok) return;
  const { projectId, itemId } = req.body || {};
  if (!projectId || !itemId) return res.status(400).json({ error: 'projectId and itemId required' });
  try {
    const { urn, fileName } = await aps.importBIM360Item(tok, projectId, itemId);
    await aps.startTranslation(urn);
    p.drawings = p.drawings || [];
    p.drawings.push({
      id: uuid(),
      name: fileName,
      urn,
      status: 'processing',
      aps_stage: 'translating',
      source: 'bim360-acc',
      uploaded_at: new Date().toISOString(),
    });
    await saveProject(p);
    res.json({ ok: true, urn, name: fileName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================================
// WEBHOOKS — register callback + handle translation-complete events
// ============================================================================

app.post('/api/aps/webhooks/register', async (req, res) => {
  const callbackUrl = req.body?.callbackUrl;
  if (!callbackUrl) return res.status(400).json({ error: 'callbackUrl required (must be public HTTPS)' });
  try { res.json({ hook: await aps.ensureWebhook(callbackUrl) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/aps/webhooks', async (req, res) => {
  try { res.json({ hooks: await aps.listWebhooks() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/aps/webhooks/:hookId', async (req, res) => {
  try { await aps.deleteWebhook(req.params.hookId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Webhook receiver — APS POSTs here when translation finishes.
// Update the matching drawing's status without polling.
app.post('/api/aps/webhooks/callback', async (req, res) => {
  // Acknowledge immediately so APS doesn't retry; do work asynchronously.
  res.json({ ok: true });
  try {
    const payload = req.body || {};
    const urn  = payload?.payload?.URN || payload?.payload?.urn || payload?.URN;
    const status = (payload?.payload?.Status || payload?.payload?.status || '').toLowerCase();
    if (!urn) return;
    // Find any project containing this URN and update its drawing status.
    const files = fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf8'));
      const d = (p.drawings || []).find(d => d.urn === urn);
      if (!d) continue;
      d.status    = status === 'success' ? 'parsed' : (status === 'failed' ? 'failed' : 'processing');
      d.aps_stage = status === 'success' ? 'extracted' : 'translating';
      d.webhook_received_at = new Date().toISOString();
      await saveProject(p);
      console.log(`[webhook] urn=${urn.slice(0, 30)}… → ${d.status} (project ${p.id})`);
    }
  } catch (e) {
    console.warn('[webhook] callback handler error:', e.message);
  }
});

// On boot: register the webhook with APS if APS_WEBHOOK_URL is configured.
// (You need a public HTTPS URL — set this in .env when deployed.)
if (process.env.APS_WEBHOOK_URL) {
  aps.ensureWebhook(process.env.APS_WEBHOOK_URL).catch(e => console.warn('[aps] boot webhook ensure failed:', e.message));
}

// ---------------- error handler ----------------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'internal error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Halford workbench server: http://localhost:${PORT}`);
  console.log(`UI: http://localhost:${PORT}/halford_ai_qs_workbench.html`);
});
