// Optional bridge to the Python solver service. When SOLVER_URL is set, the
// schedule optimizer + IFC/PDF fallback parsers route through there.

const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

const useSolver = !!process.env.SOLVER_URL;
const URL = process.env.SOLVER_URL;

async function optimize(activities, constraints, objective = 'balanced') {
  if (!useSolver) return null;
  const r = await axios.post(`${URL}/optimize`, { activities, constraints, objective }, { timeout: 30000 });
  return r.data;
}

async function predictCost({ projectType, location, gfa, storeys = 1, quality = 'standard' }) {
  if (!useSolver) return null;
  const r = await axios.post(`${URL}/predict-cost`, { project_type: projectType, location, gfa, storeys, quality });
  return r.data;
}

async function parseIfc(filePath) {
  if (!useSolver) return null;
  const fd = new FormData();
  fd.append('file', fs.createReadStream(filePath));
  const r = await axios.post(`${URL}/parse-ifc`, fd, {
    headers: fd.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 60000,
  });
  return r.data;
}

async function parsePdf(filePath) {
  if (useSolver) {
    const fd = new FormData();
    fd.append('file', fs.createReadStream(filePath));
    const r = await axios.post(`${URL}/parse-pdf`, fd, {
      headers: fd.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 30000,
    });
    return r.data;
  }
  // Local fallback via pdf-parse (no Python solver needed)
  try {
    const pdfParse = require('pdf-parse');
    const buf = fs.readFileSync(filePath);
    const data = await pdfParse(buf);
    const text = data.text || '';
    // Heuristic title block: last 800 chars often contains title/revision block
    const titleBlock = text.length > 800 ? text.slice(-800).trim() : '';
    return {
      page_count: data.numpages,
      pages: [{ page: 1, text_excerpt: text.slice(0, 3000), title_block: titleBlock, n_chars: text.length }],
    };
  } catch (e) {
    console.warn('[solver] local pdf-parse fallback failed:', e.message);
    return null;
  }
}

async function simulate(activities, crewCount = 8, iterations = 100) {
  if (!useSolver) return null;
  const r = await axios.post(`${URL}/simulate`, { activities, crew_count: crewCount, iterations });
  return r.data;
}

module.exports = { useSolver, optimize, predictCost, parseIfc, parsePdf, simulate };
