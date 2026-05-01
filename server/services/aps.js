// Autodesk Platform Services (APS, formerly Forge) integration.
// Docs: https://aps.autodesk.com/en/docs/oauth/v2/reference/http/
//       https://aps.autodesk.com/en/docs/data/v2/reference/http/
//       https://aps.autodesk.com/en/docs/model-derivative/v2/reference/http/

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const APS_BASE = 'https://developer.api.autodesk.com';
const SCOPES = 'data:read data:write data:create bucket:create bucket:read viewables:read';

// Wrap axios calls so APS error responses surface URL + status + APS-specific
// error body instead of the generic "Request failed with status code 404".
function decorate(e, context) {
  const status = e.response?.status;
  const data = e.response?.data;
  const body = typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data || {}).slice(0, 300);
  const wrapped = new Error(`APS ${context} → ${status || 'no-response'}: ${body}`);
  wrapped.status = status;
  wrapped.original = e;
  return wrapped;
}

let _token = null;
let _tokenExp = 0;

async function getToken() {
  const now = Date.now();
  if (_token && now < _tokenExp - 60_000) return _token;

  const id = process.env.APS_CLIENT_ID;
  const secret = process.env.APS_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error('APS_CLIENT_ID and APS_CLIENT_SECRET must be set in .env');
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('scope', SCOPES);

  const resp = await axios.post(
    `${APS_BASE}/authentication/v2/token`,
    params,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      },
    }
  );

  _token = resp.data.access_token;
  _tokenExp = now + resp.data.expires_in * 1000;
  return _token;
}

function safeBucketKey(projectId) {
  // bucket keys: lower-case, alphanumeric/hyphen/underscore, 3-128 chars, globally unique.
  const id = (process.env.APS_CLIENT_ID || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  return `halford-${id}-${projectId}`.toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 100);
}

async function ensureBucket(bucketKey) {
  const token = await getToken();
  try {
    await axios.get(`${APS_BASE}/oss/v2/buckets/${bucketKey}/details`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`[aps] bucket exists: ${bucketKey}`);
    return bucketKey;
  } catch (e) {
    if (e.response && e.response.status !== 404) {
      throw decorate(e, `GET /oss/v2/buckets/${bucketKey}/details`);
    }
  }
  try {
    await axios.post(
      `${APS_BASE}/oss/v2/buckets`,
      { bucketKey, policyKey: 'transient' },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[aps] bucket created: ${bucketKey}`);
  } catch (e) {
    // 409 = bucket exists (possibly under another tenant). Try to use it anyway.
    if (e.response?.status === 409) {
      console.warn(`[aps] bucket ${bucketKey} taken (409); proceeding`);
      return bucketKey;
    }
    throw decorate(e, `POST /oss/v2/buckets ${bucketKey}`);
  }
  return bucketKey;
}

// Upload via signed-S3 (current OSS recommendation, replaces the deprecated direct PUT).
async function uploadFile(bucketKey, objectName, filePath) {
  const token = await getToken();
  const stat = fs.statSync(filePath);
  console.log(`[aps] uploading ${objectName} (${stat.size} bytes) to ${bucketKey}`);

  // 1. Get signed S3 upload URL(s)
  let signed;
  try {
    signed = await axios.get(
      `${APS_BASE}/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(objectName)}/signeds3upload`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { parts: 1 },
      }
    );
  } catch (e) {
    throw decorate(e, `GET signeds3upload ${bucketKey}/${objectName}`);
  }
  const { urls, uploadKey } = signed.data;

  // 2. PUT the file to S3
  const data = fs.readFileSync(filePath);
  try {
    await axios.put(urls[0], data, {
      headers: { 'Content-Length': stat.size },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  } catch (e) {
    throw decorate(e, `PUT to signed S3 URL`);
  }

  // 3. Finalize the upload
  let finalize;
  try {
    finalize = await axios.post(
      `${APS_BASE}/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(objectName)}/signeds3upload`,
      { uploadKey },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    throw decorate(e, `POST finalize signeds3upload`);
  }
  console.log(`[aps] uploaded ${objectName} → objectId ${finalize.data.objectId}`);
  return finalize.data;
}

function urnFromObjectId(objectId) {
  return Buffer.from(objectId).toString('base64').replace(/=+$/, '');
}

async function startTranslation(urn) {
  const token = await getToken();
  const job = {
    input: { urn },
    output: {
      formats: [
        { type: 'svf2', views: ['2d', '3d'] },
      ],
    },
  };
  try {
    await axios.post(`${APS_BASE}/modelderivative/v2/designdata/job`, job, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-ads-force': 'true',
      },
    });
    console.log(`[aps] translation job started for urn=${urn.slice(0, 40)}…`);
  } catch (e) {
    throw decorate(e, `POST modelderivative/v2/designdata/job`);
  }
}

async function getManifest(urn) {
  const token = await getToken();
  try {
    const resp = await axios.get(
      `${APS_BASE}/modelderivative/v2/designdata/${urn}/manifest`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return resp.data;
  } catch (e) { throw decorate(e, `GET manifest ${urn.slice(0, 30)}`); }
}

async function getMetadata(urn) {
  const token = await getToken();
  try {
    const resp = await axios.get(
      `${APS_BASE}/modelderivative/v2/designdata/${urn}/metadata`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return resp.data;
  } catch (e) { throw decorate(e, `GET metadata ${urn.slice(0, 30)}`); }
}

async function getProperties(urn, guid) {
  const token = await getToken();
  // First call may return 202 while indexing — retry briefly.
  for (let i = 0; i < 24; i++) {
    const resp = await axios.get(
      `${APS_BASE}/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties`,
      {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
        // forceget: true requests a re-index and a complete dataset rather than the cached page.
        params: { forceget: 'true' },
      }
    );
    if (resp.status === 200 && resp.data && resp.data.data) return resp.data;
    if (resp.status === 202) {
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }
    throw new Error(`Properties API ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
  }
  throw new Error('Properties extraction timed out');
}

// Full object hierarchy (which assembly each element belongs to). Used to scope
// elements to the correct discipline (Walls/Columns under Structural, FCUs under MEP, etc.)
async function getObjectTree(urn, guid) {
  const token = await getToken();
  for (let i = 0; i < 24; i++) {
    const resp = await axios.get(
      `${APS_BASE}/modelderivative/v2/designdata/${urn}/metadata/${guid}`,
      { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true }
    );
    if (resp.status === 200 && resp.data?.data) return resp.data;
    if (resp.status === 202) { await new Promise(r => setTimeout(r, 5000)); continue; }
    throw new Error(`ObjectTree API ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
  }
  throw new Error('Object tree extraction timed out');
}

// Read-only token for the front-end APS Viewer SDK. Scoped to viewables:read only.
async function getViewerToken() {
  const id = process.env.APS_CLIENT_ID;
  const secret = process.env.APS_CLIENT_SECRET;
  if (!id || !secret) throw new Error('APS credentials not configured');

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('scope', 'viewables:read');

  const resp = await axios.post(
    `${APS_BASE}/authentication/v2/token`,
    params,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      },
    }
  );
  return { access_token: resp.data.access_token, expires_in: resp.data.expires_in };
}

// ──────────────────────────────────────────────────────────────────────────────
// PROPERTIES DATABASE (PDB) — SQLite dump of every parameter, queryable.
// APS produces a `.db.sqlite` derivative for every translated Revit/IFC model.
// We download it locally and run real SQL against it. This is the gold-standard
// data source — it has every property of every element with no truncation.
// ──────────────────────────────────────────────────────────────────────────────

let _Database; // lazy-load better-sqlite3 so the server still boots without it
function loadSQLite() {
  if (_Database) return _Database;
  try {
    _Database = require('better-sqlite3');
    return _Database;
  } catch (e) {
    throw new Error('better-sqlite3 not installed — run `npm install` in server/');
  }
}

// Walk a manifest and find every PDB derivative URN (one per viewable model).
function findPDBDerivatives(manifest) {
  const out = [];
  function walk(node) {
    if (!node) return;
    if (node.role === 'Autodesk.CloudPlatform.PropertyDatabase' && node.urn) {
      out.push({ urn: node.urn, mime: node.mime || 'application/autodesk-db' });
    }
    if (Array.isArray(node.derivatives)) node.derivatives.forEach(walk);
    if (Array.isArray(node.children))    node.children.forEach(walk);
  }
  walk(manifest);
  return out;
}

// Download a derivative file (sqlite blob) from APS to a local cache path and return it.
async function downloadDerivative(urn, derivativeUrn, destPath) {
  const token = await getToken();
  const resp = await axios.get(
    `${APS_BASE}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/manifest/${encodeURIComponent(derivativeUrn)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      validateStatus: () => true,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }
  );
  if (resp.status !== 200) throw new Error(`Derivative download ${resp.status}: ${resp.data?.toString?.().slice(0,200)}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.from(resp.data));
  return destPath;
}

// Local cache path for a PDB sqlite file. Keyed by URN hash so re-translations replace cleanly.
// Honours DATA_DIR / PDB_CACHE_DIR env vars so it can be mounted on Render's persistent disk.
function pdbCachePath(urn, derivativeUrn) {
  const root = process.env.PDB_CACHE_DIR
    || path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'pdb-cache');
  const key  = Buffer.from(urn + '::' + derivativeUrn).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0, 40);
  return path.join(root, `${key}.sqlite`);
}

// Open (and download if needed) the PDB sqlite for a urn. Returns a better-sqlite3 Database.
async function openPDB(urn, manifest) {
  const m = manifest || await getManifest(urn);
  const pdbs = findPDBDerivatives(m);
  if (!pdbs.length) throw new Error('No Property Database derivative in manifest (file may be PDF/image)');
  // Use the first PDB derivative (most files have just one)
  const dest = pdbCachePath(urn, pdbs[0].urn);
  if (!fs.existsSync(dest)) {
    console.log(`[aps] downloading PDB derivative → ${path.basename(dest)}`);
    await downloadDerivative(urn, pdbs[0].urn, dest);
  }
  const sqlite = loadSQLite();
  return sqlite(dest, { readonly: true, fileMustExist: true });
}

// Run SQL against the PDB. Auto-opens; caller can pass an opened DB to reuse it.
async function queryPDB(urn, sql, params = [], db = null) {
  const handle = db || await openPDB(urn);
  try {
    const stmt = handle.prepare(sql);
    return params.length ? stmt.all(...params) : stmt.all();
  } finally {
    if (!db) handle.close();
  }
}

// Pre-canned QS queries. Returns aggregated quantities by category — the kind a
// quantity surveyor would compute manually from a Revit schedule.
async function pdbQuantitySurvey(urn) {
  const db = await openPDB(urn);
  try {
    // The APS PDB schema:  _objects_id  _objects_attr  _objects_val  _objects_eav
    // We dynamically discover it because schema can vary slightly between Forge/APS versions.
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
    const result = { tables, summary: {} };

    if (tables.includes('_objects_attr') && tables.includes('_objects_val') && tables.includes('_objects_eav')) {
      // Total elements
      result.summary.total_elements = db.prepare(`SELECT COUNT(DISTINCT entity_id) AS n FROM _objects_eav`).get().n;

      // Categories (Revit "Category" parameter)
      result.summary.by_category = db.prepare(`
        SELECT v.value AS category, COUNT(DISTINCT e.entity_id) AS instances
        FROM _objects_eav e
        JOIN _objects_attr a ON e.attribute_id = a.id
        JOIN _objects_val  v ON e.value_id     = v.id
        WHERE a.name = 'Category'
        GROUP BY v.value
        ORDER BY instances DESC
      `).all();

      // Element types (family/type)
      result.summary.by_type = db.prepare(`
        SELECT v.value AS type_name, COUNT(DISTINCT e.entity_id) AS instances
        FROM _objects_eav e
        JOIN _objects_attr a ON e.attribute_id = a.id
        JOIN _objects_val  v ON e.value_id     = v.id
        WHERE a.name IN ('_RFT', 'Family and Type', 'Type Name', 'Family Name')
        GROUP BY v.value
        ORDER BY instances DESC
        LIMIT 200
      `).all();

      // Levels (storey count)
      result.summary.by_level = db.prepare(`
        SELECT v.value AS level, COUNT(DISTINCT e.entity_id) AS instances
        FROM _objects_eav e
        JOIN _objects_attr a ON e.attribute_id = a.id
        JOIN _objects_val  v ON e.value_id     = v.id
        WHERE a.name IN ('Level', 'Reference Level', 'Base Constraint')
        GROUP BY v.value
        ORDER BY instances DESC
      `).all();

      // Sum numeric quantities (Volume, Area, Length) by category
      result.summary.quantities = db.prepare(`
        SELECT cat.value AS category, a.name AS quantity, SUM(CAST(v.value AS REAL)) AS total
        FROM _objects_eav e
        JOIN _objects_attr a   ON e.attribute_id = a.id
        JOIN _objects_val  v   ON e.value_id     = v.id
        JOIN _objects_eav  ec  ON ec.entity_id   = e.entity_id
        JOIN _objects_attr ac  ON ec.attribute_id = ac.id AND ac.name = 'Category'
        JOIN _objects_val  cat ON ec.value_id    = cat.id
        WHERE a.name IN ('Volume', 'Area', 'Length', 'Width', 'Height')
        GROUP BY cat.value, a.name
        ORDER BY cat.value, a.name
      `).all();
    }

    return result;
  } finally {
    db.close();
  }
}

// Thumbnail of the model for UI cards. Returns a Buffer (PNG).
// `guid` is optional — when provided, renders that specific viewable (sheet/view).
// `width`/`height` accept the APS preset sizes 100/200/400 plus any value up to 1024 (master)
// or per-viewable up to 1024 as well.
async function getThumbnail(urn, width = 400, height = 400, guid = null) {
  const token = await getToken();
  try {
    const params = { width, height };
    if (guid) params.guid = guid;
    const resp = await axios.get(
      `${APS_BASE}/modelderivative/v2/designdata/${urn}/thumbnail`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params,
        responseType: 'arraybuffer',
        validateStatus: () => true,
      }
    );
    if (resp.status === 200) return Buffer.from(resp.data);
    return null;
  } catch (e) { return null; }
}

// Render every 2D sheet (floor plans, sections, schedules) of a translated drawing
// at max resolution. Returns [{ name, role, type, buffer }, ...] — Claude can read
// these directly via vision blocks. Limited to `limit` sheets to stay within Anthropic
// payload limits (~20 images recommended per call).
async function renderSheets(urn, viewables, limit = 20) {
  const out = [];
  // Prefer 2D sheets first (floor plans, schedules, elevations) — these have the QS-relevant
  // dimensioned info. Fall back to 3D views if not enough 2D.
  const sorted = (viewables || [])
    .slice()
    .sort((a, b) => {
      const aIs2d = a.role === '2d' ? 0 : 1;
      const bIs2d = b.role === '2d' ? 0 : 1;
      return aIs2d - bIs2d;
    })
    .slice(0, limit);
  for (const v of sorted) {
    try {
      const buf = await getThumbnail(urn, 1024, 1024, v.guid);
      if (buf && buf.length > 1000) out.push({ name: v.name, role: v.role, type: v.type, buffer: buf });
    } catch (e) { /* skip view */ }
  }
  return out;
}

// High-level: upload + translate + wait for completion. Returns { urn, status, properties }.
async function processDrawing(projectId, fileName, filePath, onProgress) {
  const bucketKey = safeBucketKey(projectId);
  await ensureBucket(bucketKey);
  onProgress && onProgress('uploading');

  const objectName = `${Date.now()}_${fileName}`;
  const obj = await uploadFile(bucketKey, objectName, filePath);
  const urn = urnFromObjectId(obj.objectId);

  onProgress && onProgress('translating');
  await startTranslation(urn);

  // Poll manifest
  for (let i = 0; i < 60; i++) {
    const m = await getManifest(urn);
    if (m.status === 'success') break;
    if (m.status === 'failed') throw new Error('APS translation failed: ' + (m.messages?.[0]?.message || 'unknown'));
    await new Promise(r => setTimeout(r, 5000));
  }

  onProgress && onProgress('extracting');
  let meta;
  try {
    meta = await getMetadata(urn);
  } catch (e) {
    // PDFs / images don't have a property database — APS returns 404 with
    // "No Property Database found under this URN". This is expected; the
    // viewable is still produced, we just have no semantic elements.
    if (e.status === 404 || /No Property Database/i.test(e.message)) {
      console.log(`[aps] no property database for ${fileName} (PDF/image — Claude will infer from filename)`);
      onProgress && onProgress('done');
      return { urn, properties: [], object_tree: null, viewables: [], note: 'no_property_database' };
    }
    throw e;
  }

  const allViewables = meta.data?.metadata || [];
  // Process EVERY viewable — 3D models, every floor plan, every section, every schedule sheet.
  // Multi-discipline coordination requires us to read all sheets, not just the first 3D view.
  console.log(`[aps] ${fileName}: processing ${allViewables.length} viewable(s)`);

  const properties = [];
  const objectTrees = [];
  const viewableIndex = [];
  let masterTree = null;

  for (const view of allViewables) {
    viewableIndex.push({
      guid:   view.guid,
      name:   view.name,
      role:   view.role,    // '3d' | '2d'
      type:   view.type,    // 'view' | 'sheet' | 'geometry'
      hasThumbnail: !!view.hasThumbnail,
    });

    // 1. Properties (full element list — no cap)
    try {
      const p = await getProperties(urn, view.guid);
      const items = p.data?.collection || [];
      properties.push({
        view:   view.name,
        role:   view.role,
        type:   view.type,
        guid:   view.guid,
        count:  items.length,
        items,
      });
      console.log(`[aps]   view "${view.name}" (${view.role}): ${items.length} elements`);
    } catch (e) {
      console.warn(`[aps]   view "${view.name}" properties failed: ${e.message.slice(0, 100)}`);
    }

    // 2. Object tree (parent/child hierarchy — gives us assembly context)
    try {
      const tree = await getObjectTree(urn, view.guid);
      objectTrees.push({ view: view.name, role: view.role, tree: tree.data });
      // Pick the richest 3D tree as the "master" for downstream analysis.
      if (view.role === '3d' && (!masterTree || (tree.data?.objects?.length || 0) > (masterTree?.objects?.length || 0))) {
        masterTree = tree.data;
      }
    } catch (e) {
      // object tree is optional — properties alone still drive extraction
    }
  }

  // Fetch a thumbnail for the UI (best-effort)
  let thumbnail = null;
  try {
    const buf = await getThumbnail(urn, 600, 400);
    if (buf) thumbnail = 'data:image/png;base64,' + buf.toString('base64');
  } catch (e) { /* non-critical */ }

  // Pull the Properties Database (SQLite) and run the QS quantity survey.
  // This is the gold-standard data source — exact counts/lengths/areas with no truncation.
  let pdb_survey = null;
  try {
    onProgress && onProgress('pdb-survey');
    pdb_survey = await pdbQuantitySurvey(urn);
    console.log(`[aps] PDB survey: ${pdb_survey.summary?.total_elements || 0} elements, ${pdb_survey.summary?.by_category?.length || 0} categories`);
  } catch (e) {
    console.log(`[aps] PDB survey unavailable: ${e.message.slice(0, 100)}`);
  }

  onProgress && onProgress('done');
  return {
    urn,
    properties,
    object_trees: objectTrees,
    master_tree:  masterTree,
    viewables:    viewableIndex,
    thumbnail,
    pdb_survey,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// WEBHOOKS — push notifications on translation completion (replaces polling).
// Docs: https://aps.autodesk.com/en/docs/webhooks/v1/reference/http/systems/
// ──────────────────────────────────────────────────────────────────────────────
async function listWebhooks() {
  const token = await getToken();
  const resp = await axios.get(
    `${APS_BASE}/webhooks/v1/systems/derivative/events/extraction.finished/hooks`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return resp.data?.data || [];
}

async function registerWebhook(callbackUrl, scope = {}) {
  const token = await getToken();
  // scope: { workflow: '<id>' } scopes the hook so we only get callbacks for our jobs.
  const body = {
    callbackUrl,
    scope: scope.workflow ? { workflow: scope.workflow } : { workflow: 'halford-default' },
    hookAttribute: { description: 'Halford AI QS Workbench — translation complete' },
  };
  const resp = await axios.post(
    `${APS_BASE}/webhooks/v1/systems/derivative/events/extraction.finished/hooks`,
    body,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return resp.data;
}

async function deleteWebhook(hookId) {
  const token = await getToken();
  await axios.delete(
    `${APS_BASE}/webhooks/v1/systems/derivative/events/extraction.finished/hooks/${hookId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

// Ensure exactly one webhook exists for the given callback URL — idempotent.
async function ensureWebhook(callbackUrl) {
  if (!callbackUrl) return null;
  try {
    const hooks = await listWebhooks();
    const existing = hooks.find(h => h.callbackUrl === callbackUrl);
    if (existing) {
      console.log(`[aps] webhook already registered: ${existing.hookId}`);
      return existing;
    }
    const created = await registerWebhook(callbackUrl, { workflow: 'halford-default' });
    console.log(`[aps] webhook registered: ${callbackUrl}`);
    return created;
  } catch (e) {
    console.warn(`[aps] webhook setup failed (will fall back to polling): ${e.message.slice(0, 200)}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// DATA MANAGEMENT API — 3-legged OAuth + BIM 360 / ACC hubs/projects browsing.
// Docs: https://aps.autodesk.com/en/docs/data/v2/reference/http/
// ──────────────────────────────────────────────────────────────────────────────
const _userTokens = new Map(); // sessionId → { access_token, refresh_token, expires_at }

function buildAuthorizeUrl(redirectUri, state, scopes) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.APS_CLIENT_ID || '',
    redirect_uri:  redirectUri,
    scope:         (scopes || ['data:read', 'data:write', 'data:create', 'account:read', 'viewables:read']).join(' '),
    state:         state || '',
  });
  return `${APS_BASE}/authentication/v2/authorize?${params}`;
}

async function exchangeCodeForToken(code, redirectUri) {
  const id     = process.env.APS_CLIENT_ID;
  const secret = process.env.APS_CLIENT_SECRET;
  const params = new URLSearchParams();
  params.append('grant_type', 'authorization_code');
  params.append('code', code);
  params.append('redirect_uri', redirectUri);

  const resp = await axios.post(
    `${APS_BASE}/authentication/v2/token`,
    params,
    {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        Authorization:   'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      },
    }
  );
  return resp.data;
}

async function refreshUserToken(refreshToken) {
  const id     = process.env.APS_CLIENT_ID;
  const secret = process.env.APS_CLIENT_SECRET;
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refreshToken);

  const resp = await axios.post(
    `${APS_BASE}/authentication/v2/token`,
    params,
    {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        Authorization:   'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      },
    }
  );
  return resp.data;
}

function storeUserToken(sessionId, tokenResp) {
  _userTokens.set(sessionId, {
    access_token:  tokenResp.access_token,
    refresh_token: tokenResp.refresh_token,
    expires_at:    Date.now() + (tokenResp.expires_in - 60) * 1000,
  });
}

async function getUserToken(sessionId) {
  const t = _userTokens.get(sessionId);
  if (!t) return null;
  if (Date.now() >= t.expires_at && t.refresh_token) {
    try {
      const refreshed = await refreshUserToken(t.refresh_token);
      storeUserToken(sessionId, refreshed);
      return refreshed.access_token;
    } catch (e) {
      _userTokens.delete(sessionId);
      return null;
    }
  }
  return t.access_token;
}

// List the user's BIM 360 / ACC hubs.
async function listHubs(userToken) {
  const resp = await axios.get(
    `${APS_BASE}/project/v1/hubs`,
    { headers: { Authorization: `Bearer ${userToken}` } }
  );
  return resp.data?.data || [];
}

// List projects within a hub.
async function listProjects(userToken, hubId) {
  const resp = await axios.get(
    `${APS_BASE}/project/v1/hubs/${encodeURIComponent(hubId)}/projects`,
    { headers: { Authorization: `Bearer ${userToken}` } }
  );
  return resp.data?.data || [];
}

// List top-level folders for a project.
async function listTopFolders(userToken, hubId, projectId) {
  const resp = await axios.get(
    `${APS_BASE}/project/v1/hubs/${encodeURIComponent(hubId)}/projects/${encodeURIComponent(projectId)}/topFolders`,
    { headers: { Authorization: `Bearer ${userToken}` } }
  );
  return resp.data?.data || [];
}

// Browse folder contents (sub-folders + items).
async function listFolderContents(userToken, projectId, folderId) {
  const resp = await axios.get(
    `${APS_BASE}/data/v1/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/contents`,
    { headers: { Authorization: `Bearer ${userToken}` } }
  );
  return resp.data?.data || [];
}

// Get the storage location of an item's tip version (so we can copy it into our OSS bucket).
async function getItemTipStorage(userToken, projectId, itemId) {
  const itemResp = await axios.get(
    `${APS_BASE}/data/v1/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`,
    { headers: { Authorization: `Bearer ${userToken}` } }
  );
  const tipVersion = itemResp.data?.data?.relationships?.tip?.data?.id;
  if (!tipVersion) return null;
  const verResp = await axios.get(
    `${APS_BASE}/data/v1/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(tipVersion)}`,
    { headers: { Authorization: `Bearer ${userToken}` } }
  );
  const storageUrn = verResp.data?.data?.relationships?.storage?.data?.id;
  const fileName   = verResp.data?.data?.attributes?.displayName;
  return { storageUrn, fileName, version: tipVersion };
}

// Import an item from BIM 360/ACC: download its tip version then upload it into our OSS bucket.
async function importBIM360Item(userToken, projectId, itemId, ourBucketKey) {
  const tip = await getItemTipStorage(userToken, projectId, itemId);
  if (!tip) throw new Error('Could not resolve tip version for item ' + itemId);
  // storageUrn is of form: urn:adsk.objects:os.object:<bucket>/<object>
  // Translate it directly via Model Derivative — no need to copy bytes, APS reads from BIM 360 storage.
  const urn = Buffer.from(tip.storageUrn).toString('base64').replace(/=+$/, '');
  return { urn, fileName: tip.fileName, source: 'bim360-acc' };
}

module.exports = {
  // Auth
  getToken,
  getViewerToken,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshUserToken,
  storeUserToken,
  getUserToken,
  // OSS
  ensureBucket,
  uploadFile,
  urnFromObjectId,
  safeBucketKey,
  // Model Derivative
  startTranslation,
  getManifest,
  getMetadata,
  getProperties,
  getObjectTree,
  getThumbnail,
  renderSheets,
  // PDB SQLite
  findPDBDerivatives,
  downloadDerivative,
  openPDB,
  queryPDB,
  pdbQuantitySurvey,
  // High-level pipeline
  processDrawing,
  // Webhooks
  listWebhooks,
  registerWebhook,
  deleteWebhook,
  ensureWebhook,
  // Data Management (BIM 360 / ACC)
  listHubs,
  listProjects,
  listTopFolders,
  listFolderContents,
  getItemTipStorage,
  importBIM360Item,
};
