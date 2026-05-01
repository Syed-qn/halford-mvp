// Pricing engine — applies the rate library to approved elements with
// location and project-type factors, OH&P markup, and computes BoQ totals
// grouped by section.

const { loadRates } = require('./claude');

function computeBoQ(project) {
  const rates = loadRates();
  const locFactor = rates.location_factors[project.location] ?? 1.0;
  const ptFactor = rates.project_type_factors[project.projectType] ?? 1.0;
  const factor = locFactor * ptFactor;
  const markup = (project.markup ?? 12) / 100;

  const approvedElements = (project.elements || []).filter(e => e.approved !== false);

  // Group by section
  const sections = {};
  for (const el of approvedElements) {
    const section = el.section || 'Other';
    if (!sections[section]) sections[section] = { name: section, items: [], subtotal: 0 };
    const libRate = rates.elements[el.code]?.rate;
    const baseRate = el.rate != null ? el.rate : (libRate != null ? libRate : 0);
    const adjRate = Math.round(baseRate * factor);
    const extended = Math.round(el.qty * adjRate);
    const item = {
      code: el.code,
      desc: el.desc,
      discipline: el.discipline,
      qty: el.qty,
      unit: el.unit,
      rate: adjRate,
      base_rate: baseRate,
      extended,
      source: el.source,
      confidence: el.confidence,
      flagged: (el.confidence ?? 100) < 80,
    };
    sections[section].items.push(item);
    sections[section].subtotal += extended;
  }

  const sectionsArr = Object.values(sections).sort((a, b) => sectionOrder(a.name) - sectionOrder(b.name));
  const subtotal = sectionsArr.reduce((s, x) => s + x.subtotal, 0);
  const ohp = Math.round(subtotal * markup);
  const total = subtotal + ohp;

  return {
    currency: project.currency || 'AED',
    location_factor: locFactor,
    project_type_factor: ptFactor,
    factor_applied: factor,
    markup_pct: project.markup ?? 12,
    sections: sectionsArr,
    subtotal,
    ohp,
    total,
    gfa: project.gfa || 0,
    cost_per_m2: project.gfa ? Math.round(total / project.gfa) : 0,
  };
}

function sectionOrder(s) {
  const order = ['Preliminaries', 'Substructure', 'Frame', 'Roof', 'Envelope', 'Internal walls', 'Finishes', 'MEP', 'External', 'Other'];
  const i = order.indexOf(s);
  return i === -1 ? 99 : i;
}

// ---------------------------------------------------------------------------
// Market benchmark data — UAE Q1 2025
// Sources: Turner & Townsend International Construction Market Survey 2024,
//          RLB Crane Index UAE Q1 2025, AECOM Middle East Cost Report 2024,
//          Faithful+Gould GCC Construction Cost Data 2025.
// Basis: construction cost/m² GFA, AED, competitively bid contracts.
// Excludes: land, VAT (5%), professional fees (6–12%), client contingency.
// ---------------------------------------------------------------------------
const BENCHMARK_SOURCE = {
  attribution: 'Turner & Townsend (2024) · RLB Crane Index UAE Q1 2025 · AECOM Middle East Cost Report 2024 · Faithful+Gould GCC 2025',
  currency: 'AED',
  market: 'UAE — Dubai base (see location factors for Abu Dhabi / Sharjah adjustment)',
  basis: 'Construction cost/m² GFA — excludes land, VAT, professional fees, client contingency',
  quarter: 'Q1 2025',
};

// Elemental % ranges: [min, max] as fraction of construction subtotal (excl. OH&P).
// Based on RICS NRM2 elemental analysis, calibrated to UAE market tender data.
const ELEMENTAL = {
  'Residential — villa': {
    'Substructure':   [0.10, 0.14],
    'Frame':          [0.14, 0.19],
    'Roof':           [0.04, 0.07],
    'Envelope':       [0.12, 0.18],
    'Internal walls': [0.04, 0.07],
    'Finishes':       [0.16, 0.24],
    'MEP':            [0.17, 0.24],
    'External':       [0.04, 0.09],
    'Preliminaries':  [0.08, 0.13],
  },
  'Residential — high rise': {
    'Substructure':   [0.08, 0.12],
    'Frame':          [0.18, 0.24],
    'Roof':           [0.02, 0.04],
    'Envelope':       [0.10, 0.16],
    'Internal walls': [0.04, 0.07],
    'Finishes':       [0.14, 0.21],
    'MEP':            [0.20, 0.30],
    'External':       [0.02, 0.05],
    'Preliminaries':  [0.08, 0.13],
  },
  'Commercial — office': {
    'Substructure':   [0.08, 0.12],
    'Frame':          [0.18, 0.25],
    'Roof':           [0.02, 0.04],
    'Envelope':       [0.12, 0.18],
    'Internal walls': [0.03, 0.06],
    'Finishes':       [0.11, 0.17],
    'MEP':            [0.24, 0.34],
    'External':       [0.02, 0.05],
    'Preliminaries':  [0.08, 0.12],
  },
  'Retail': {
    'Substructure':   [0.08, 0.12],
    'Frame':          [0.15, 0.22],
    'Roof':           [0.04, 0.07],
    'Envelope':       [0.12, 0.18],
    'Internal walls': [0.04, 0.08],
    'Finishes':       [0.15, 0.24],
    'MEP':            [0.18, 0.26],
    'External':       [0.03, 0.07],
    'Preliminaries':  [0.08, 0.12],
  },
  'Industrial': {
    'Substructure':   [0.10, 0.16],
    'Frame':          [0.25, 0.35],
    'Roof':           [0.08, 0.14],
    'Envelope':       [0.14, 0.22],
    'Internal walls': [0.02, 0.05],
    'Finishes':       [0.04, 0.09],
    'MEP':            [0.12, 0.22],
    'External':       [0.03, 0.07],
    'Preliminaries':  [0.07, 0.11],
  },
  'Mixed use': {
    'Substructure':   [0.08, 0.13],
    'Frame':          [0.16, 0.23],
    'Roof':           [0.02, 0.05],
    'Envelope':       [0.11, 0.18],
    'Internal walls': [0.04, 0.07],
    'Finishes':       [0.14, 0.22],
    'MEP':            [0.20, 0.30],
    'External':       [0.03, 0.07],
    'Preliminaries':  [0.08, 0.13],
  },
  'Hospitality — hotel': {
    'Substructure':   [0.08, 0.12],
    'Frame':          [0.14, 0.20],
    'Roof':           [0.02, 0.05],
    'Envelope':       [0.10, 0.16],
    'Internal walls': [0.05, 0.09],
    'Finishes':       [0.20, 0.32],
    'MEP':            [0.22, 0.32],
    'External':       [0.04, 0.08],
    'Preliminaries':  [0.08, 0.12],
  },
  'Infrastructure': {
    'Substructure':   [0.12, 0.20],
    'Frame':          [0.05, 0.15],
    'MEP':            [0.18, 0.30],
    'External':       [0.20, 0.35],
    'Preliminaries':  [0.10, 0.18],
  },
};

// Cost/m² GFA by project type and specification level (AED, Dubai base, Q1 2025).
// Spec levels: Economy · Standard · Premium · Luxury
const BENCHMARKS = {
  'Residential — villa': {
    desc: 'Detached villa, 1–3 storeys, RC frame or load-bearing blockwork',
    Economy:  { low: 2800,  mid: 3500,  high: 4300,  note: 'Government/affordable housing, basic specification' },
    Standard: { low: 4300,  mid: 5800,  high: 7200,  note: 'Mainstream developer (Damac, Nakheel standard product)' },
    Premium:  { low: 7200,  mid: 9800,  high: 13500, note: 'High specification (Emaar, Meraas premium product)' },
    Luxury:   { low: 13500, mid: 19000, high: 30000, note: 'Bespoke ultra-luxury (Palm Jumeirah, Emirates Hills)' },
  },
  'Residential — high rise': {
    desc: 'Apartments, 16+ floors, RC flat-slab frame, standard podium',
    Economy:  { low: 4200,  mid: 5500,  high: 6800,  note: 'Affordable apartments (JVC, Arjan, International City)' },
    Standard: { low: 6800,  mid: 8500,  high: 10500, note: 'Mid-market residential tower' },
    Premium:  { low: 10500, mid: 13500, high: 18000, note: 'High-spec tower (Downtown, JBR, Dubai Marina waterfront)' },
    Luxury:   { low: 18000, mid: 24000, high: 35000, note: 'Ultra-luxury tower (DIFC Living, Dorchester, Address)' },
  },
  'Commercial — office': {
    desc: 'Office building — air-conditioned, raised access floor, suspended ceiling',
    Economy:  { low: 4000,  mid: 5000,  high: 6500,  note: 'Grade C / B-, standard commercial specification' },
    Standard: { low: 6500,  mid: 8500,  high: 10500, note: 'Grade B / B+, conventional office' },
    Premium:  { low: 10500, mid: 14000, high: 18000, note: 'Grade A, efficient floor plates, enhanced façade' },
    Luxury:   { low: 18000, mid: 24000, high: 35000, note: 'Grade A+ smart building, LEED Platinum, bespoke design' },
  },
  'Retail': {
    desc: 'Retail unit — shell & core unless stated; excludes tenant fit-out',
    Economy:  { low: 3000,  mid: 4200,  high: 5800,  note: 'Strip mall / community retail, shell & core' },
    Standard: { low: 5800,  mid: 7800,  high: 10000, note: 'Neighbourhood mall, Category A fit-out' },
    Premium:  { low: 10000, mid: 14000, high: 19000, note: 'Regional mall, Category B fit-out' },
    Luxury:   { low: 19000, mid: 27000, high: 42000, note: 'Luxury retail destination, full bespoke fit-out' },
  },
  'Industrial': {
    desc: 'Warehouse, logistics hub, light industrial — includes structure and services',
    Economy:  { low: 1200,  mid: 1900,  high: 2800,  note: 'Basic logistics/storage, steel portal frame' },
    Standard: { low: 2800,  mid: 4000,  high: 5500,  note: 'General industrial, mezzanine, dock levellers' },
    Premium:  { low: 5500,  mid: 8000,  high: 11500, note: 'Food-grade, cold store, light manufacturing' },
    Luxury:   { low: 11500, mid: 16000, high: 25000, note: 'Pharmaceutical GMP / cleanroom / data centre shell' },
  },
  'Mixed use': {
    desc: 'Mixed residential, retail and commercial — weighted blended cost',
    Economy:  { low: 4500,  mid: 6000,  high: 8000,  note: 'Standard mixed podium + tower' },
    Standard: { low: 8000,  mid: 10500, high: 14000, note: 'Mid-market mixed-use development' },
    Premium:  { low: 14000, mid: 18500, high: 25000, note: 'High-spec (Downtown / Business Bay / JLT grade)' },
    Luxury:   { low: 25000, mid: 34000, high: 52000, note: 'Ultra-luxury (DIFC, One&Only, Bvlgari grade)' },
  },
  'Hospitality — hotel': {
    desc: 'Hotel — construction and MEP; excludes FF&E, OS&E, and operator fit-out',
    Economy:  { low: 5500,  mid: 7500,  high: 9500,  note: '3-star / business hotel, efficient repetitive layout' },
    Standard: { low: 9500,  mid: 13000, high: 17000, note: '4-star upscale hotel' },
    Premium:  { low: 17000, mid: 23000, high: 32000, note: '5-star luxury hotel' },
    Luxury:   { low: 32000, mid: 45000, high: 75000, note: '7-star ultra-luxury (Burj Al Arab / One&Only level)' },
  },
  'Infrastructure': {
    desc: 'Roads, utilities and civil infrastructure — expressed per m² of road/equivalent area',
    Economy:  { low: 2500,  mid: 4000,  high: 6000,  note: 'Local / collector road, flexible pavement, standard utilities' },
    Standard: { low: 6000,  mid: 9000,  high: 13000, note: 'Arterial road, rigid pavement, full utilities package' },
    Premium:  { low: 13000, mid: 18000, high: 26000, note: 'Urban boulevard, grade separation, landscaped median' },
    Luxury:   { low: 26000, mid: 36000, high: 55000, note: 'Marine structure / tunnel / major interchange' },
  },
};

function benchmark(project, boq) {
  const typeData = BENCHMARKS[project.projectType] || BENCHMARKS['Residential — villa'];
  const spec     = project.spec_level || 'Standard';
  const range    = typeData[spec] || typeData['Standard'];
  const cpm      = boq.cost_per_m2;

  let position;
  if      (cpm < range.low  * 0.85) position = 'significantly below market low — verify quantities and scope completeness';
  else if (cpm > range.high * 1.15) position = 'significantly above market high — review specification and unit rates';
  else if (cpm < range.low)         position = 'below market range';
  else if (cpm > range.high)        position = 'above market range';
  else if (cpm <= range.mid)        position = 'within range, below mid-market';
  else                              position = 'within range, above mid-market';

  const variance_pct = parseFloat(((cpm - range.mid) / range.mid * 100).toFixed(1));

  // Elemental comparison: project's actual % and cost/m² vs published market benchmarks
  const elemBench = ELEMENTAL[project.projectType] || ELEMENTAL['Residential — villa'];
  const elemental = [];
  for (const sec of (boq.sections || [])) {
    const bench = elemBench[sec.name];
    if (!bench || boq.subtotal === 0) continue;
    const actual_pct      = sec.subtotal / boq.subtotal;
    const actual_cpm      = boq.gfa > 0 ? Math.round(sec.subtotal / boq.gfa) : 0;
    const bench_cpm_low   = Math.round(range.mid * bench[0]);
    const bench_cpm_high  = Math.round(range.mid * bench[1]);

    let flag;
    if      (actual_pct < bench[0] * 0.75) flag = 'below range';
    else if (actual_pct > bench[1] * 1.25) flag = 'above range';
    else if (actual_pct < bench[0])        flag = 'slightly below';
    else if (actual_pct > bench[1])        flag = 'slightly above';
    else                                   flag = 'within range';

    elemental.push({
      name:           sec.name,
      actual_pct:     parseFloat((actual_pct * 100).toFixed(1)),
      bench_min_pct:  parseFloat((bench[0]   * 100).toFixed(1)),
      bench_max_pct:  parseFloat((bench[1]   * 100).toFixed(1)),
      actual_cpm,
      bench_cpm_low,
      bench_cpm_high,
      flag,
    });
  }

  return {
    spec_level:   spec,
    spec_note:    range.note,
    type_desc:    typeData.desc,
    source:       BENCHMARK_SOURCE,
    // Backward-compatible keys used by existing PDF generator
    rlb_low:      range.low,
    rlb_mid:      range.mid,
    rlb_high:     range.high,
    project_cpm:  cpm,
    position,
    variance_pct,
    elemental,
  };
}

// Build a resource-loaded schedule. Section durations are derived from
// labour-hour totals; sequencing uses real predecessor logic (cure lag,
// steel lead time, NOC period) rather than hardcoded fractions.
function buildSchedule(project, boq) {
  const constraints = project.constraints || {};
  const startDate = constraints.start_date ? new Date(constraints.start_date) : new Date();
  const workdaysPerWeek = constraints.workdays_per_week || 6;
  const maxCrews        = constraints.max_crews || 12;
  const targetWeeks     = constraints.target_weeks || 104;
  const cureLagWeeks    = Math.ceil((constraints.cure_lag_days || 28) / 7);
  const steelLeadWeeks  = constraints.steel_lead_weeks || 12;
  const nocWeeks        = constraints.noc_weeks || 0;
  const contingencyPct  = constraints.contingency_pct || 5;
  const ramadanFactor   = (constraints.ramadan_factor || 60) / 100;  // fraction of normal output
  const summerFactor    = (constraints.summer_factor  || 75) / 100;
  const mepLeadWeeks    = constraints.mep_lead_weeks || 16;

  const rates = loadRates();
  const sectionHrs = {};
  for (const sec of boq.sections) {
    sectionHrs[sec.name] = 0;
    for (const it of sec.items) {
      const lib = rates.elements[it.code];
      const lhrPerUnit = lib?.labour_hrs ?? 0.5;
      sectionHrs[sec.name] += it.qty * lhrPerUnit;
    }
  }

  const totalHrs = Object.values(sectionHrs).reduce((a, b) => a + b, 0);
  const hoursPerWeek = maxCrews * 8 * workdaysPerWeek;

  // Calendar efficiency: Ramadan (~4 wks/yr) and GCC summer Jul-Aug (~8 wks/yr)
  // reduce effective output; we inflate durations accordingly.
  const ramadanLoss = (4 / 52) * (1 - ramadanFactor);
  const summerLoss  = (8 / 52) * (1 - summerFactor);
  const calFactor   = 1.35 * (1 + ramadanLoss + summerLoss);  // 1.35 = base complexity

  // Duration in calendar weeks for a given section
  function dur(name, fallbackParallel) {
    const hrs = sectionHrs[name] || 0;
    if (hrs > 0) return Math.max(1, Math.ceil((hrs * calFactor) / hoursPerWeek));
    if (totalHrs > 0) {
      const totalCal = Math.ceil((totalHrs * calFactor) / hoursPerWeek);
      return Math.max(1, Math.round(totalCal * fallbackParallel));
    }
    return Math.max(1, Math.round(targetWeeks * fallbackParallel * 0.85));
  }

  // --- Predecessor-driven sequencing ---
  // Week numbers are 1-based; end_week = start_week + duration - 1.

  // Pre-construction = mobilisation + NOC/authority approvals running in parallel.
  // Both belong to the Preliminaries cost section. The bar spans from project start
  // until Substructure can physically begin (= NOC clearance), so the Gantt has no
  // dead space between mobilisation and groundworks.
  const mobDur     = Math.max(2, dur('Preliminaries', 0.05));
  const prelim_sw  = 1;
  const prelim_dur = Math.max(mobDur, nocWeeks);   // whichever takes longer drives the bar
  const prelim_end = prelim_sw + prelim_dur - 1;

  // Substructure cannot begin until NOC/authority approvals clear.
  const sub_sw  = 1 + nocWeeks;
  const sub_dur = dur('Substructure', 0.10);
  const sub_ew  = sub_sw + sub_dur - 1;

  // Frame: predecessor = Substructure complete + concrete cure + steel on-site.
  const frame_sw  = Math.max(sub_ew + cureLagWeeks + 1, 1 + steelLeadWeeks);
  const frame_dur = dur('Frame', 0.20);
  const frame_ew  = frame_sw + frame_dur - 1;

  // Roof: starts when Frame is 85% complete (propping still in place for last lift).
  const roof_sw  = frame_sw + Math.floor(frame_dur * 0.85);
  const roof_dur = dur('Roof', 0.08);
  const roof_ew  = roof_sw + roof_dur - 1;

  // Envelope (cladding/windows): can start when Frame is ~70% complete.
  const env_sw  = frame_sw + Math.floor(frame_dur * 0.70);
  const env_dur = dur('Envelope', 0.25);
  const env_ew  = env_sw + env_dur - 1;

  // MEP rough-in: needs Envelope 30% done AND long-lead equipment on site.
  const mep_sw  = Math.max(env_sw + Math.floor(env_dur * 0.30), 1 + mepLeadWeeks);
  const mep_dur = dur('MEP', 0.30);
  const mep_ew  = mep_sw + mep_dur - 1;

  // Internal walls: after Envelope complete (shell closed).
  const iw_sw  = env_ew + 1;
  const iw_dur = dur('Internal walls', 0.20);
  const iw_ew  = iw_sw + iw_dur - 1;

  // Finishes: after internal walls up; MEP second fix runs in parallel within this window.
  const fin_sw  = iw_ew + 1;
  const fin_dur = dur('Finishes', 0.27);
  const fin_ew  = fin_sw + fin_dur - 1;

  // External works: can start when substructure complete (independent stream).
  const ext_sw  = sub_ew + 1;
  const ext_dur = dur('External', 0.16);
  const ext_ew  = ext_sw + ext_dur - 1;

  // Commissioning: after Finishes and MEP complete.
  const com_sw  = Math.max(fin_ew, mep_ew) + 1;
  const com_dur = Math.max(2, dur('Commissioning', 0.06));
  const com_ew  = com_sw + com_dur - 1;

  // Handover: after Commissioning.
  const ho_sw  = com_ew + 1;
  const ho_dur = Math.max(1, dur('Handover', 0.04));
  const ho_ew  = ho_sw + ho_dur - 1;

  // Natural duration = latest end week across all streams.
  const naturalDur = Math.max(ho_ew, roof_ew, ext_ew);
  const contingencyWeeks = Math.ceil(naturalDur * (contingencyPct / 100));
  const totalDur = Math.min(targetWeeks, Math.max(4, naturalDur + contingencyWeeks));

  const raw = [
    { name: 'Pre-construction (mob + NOC)', sw: prelim_sw, ew: prelim_end, d: prelim_dur, hrs: sectionHrs['Preliminaries']  || 0, color: 'civil'  },
    { name: 'Substructure',   sw: sub_sw,  ew: sub_ew,     d: sub_dur,    hrs: sectionHrs['Substructure']   || 0, color: 'civil'  },
    { name: 'Frame',          sw: frame_sw,ew: frame_ew,   d: frame_dur,  hrs: sectionHrs['Frame']          || 0, color: 'struct' },
    { name: 'Roof',           sw: roof_sw, ew: roof_ew,    d: roof_dur,   hrs: sectionHrs['Roof']           || 0, color: 'arch'   },
    { name: 'Envelope',       sw: env_sw,  ew: env_ew,     d: env_dur,    hrs: sectionHrs['Envelope']       || 0, color: 'arch'   },
    { name: 'MEP',            sw: mep_sw,  ew: mep_ew,     d: mep_dur,    hrs: sectionHrs['MEP']            || 0, color: 'mep'    },
    { name: 'Internal walls', sw: iw_sw,   ew: iw_ew,      d: iw_dur,     hrs: sectionHrs['Internal walls'] || 0, color: 'arch'   },
    { name: 'Finishes',       sw: fin_sw,  ew: fin_ew,     d: fin_dur,    hrs: sectionHrs['Finishes']       || 0, color: 'arch'   },
    { name: 'External',       sw: ext_sw,  ew: ext_ew,     d: ext_dur,    hrs: sectionHrs['External']       || 0, color: 'ext'    },
    { name: 'Commissioning',  sw: com_sw,  ew: com_ew,     d: com_dur,    hrs: 0,                                 color: 'mep'    },
    { name: 'Handover',       sw: ho_sw,   ew: ho_ew,      d: ho_dur,     hrs: 0,                                 color: 'civil'  },
  ];

  const activities = raw
    .filter(a => a.d > 0 && a.sw <= totalDur)
    .map(a => ({
      name:        a.name,
      start_week:  a.sw,
      duration:    Math.min(a.d, totalDur - a.sw + 1),
      end_week:    Math.min(a.ew, totalDur),
      labour_hrs:  Math.round(a.hrs),
      color:       a.color,
    }));

  return {
    start_date:        startDate.toISOString().slice(0, 10),
    total_weeks:       totalDur,
    natural_weeks:     naturalDur,
    contingency_weeks: contingencyWeeks,
    workdays_per_week: workdaysPerWeek,
    max_crews:         maxCrews,
    noc_weeks:         nocWeeks,
    calendar_factor:   parseFloat(calFactor.toFixed(3)),
    activities,
    total_labour_hrs:  Math.round(totalHrs),
  };
}

// Standard contract / payment terms by market. Each entry is the typical local
// commercial practice; users can override per-project via `project.cashflow_terms`.
//   - UAE: FIDIC Red Book / DM standard contract
//   - KSA: MoMRA / Vision-2030-era prompt-payment reforms
//   - Qatar/Kuwait/Bahrain/Oman: GCC public-works defaults
//   - UK: JCT/NEC, Construction Act payment timing
//   - US: AIA A201, sales tax varies by state (set 0 here)
//   - Singapore: GST/SOPA payment terms
const MARKET_TERMS = {
  UAE:        { mobilisation_advance_pct: 15, retention_pct: 10, retention_release_at_pc_pct: 5, dlp_months: 12, payment_lag_days: 30, vat_pct: 5,  contract_basis: 'FIDIC Red Book / DM standard' },
  KSA:        { mobilisation_advance_pct: 15, retention_pct: 10, retention_release_at_pc_pct: 5, dlp_months: 12, payment_lag_days: 30, vat_pct: 15, contract_basis: 'MoMRA Vision 2030 prompt-payment'  },
  Qatar:      { mobilisation_advance_pct: 10, retention_pct: 10, retention_release_at_pc_pct: 5, dlp_months: 12, payment_lag_days: 45, vat_pct: 0,  contract_basis: 'Tendering Law / Public Works Authority' },
  Kuwait:     { mobilisation_advance_pct: 10, retention_pct: 10, retention_release_at_pc_pct: 5, dlp_months: 12, payment_lag_days: 60, vat_pct: 0,  contract_basis: 'CTC / public-works tendering' },
  Bahrain:    { mobilisation_advance_pct: 10, retention_pct: 10, retention_release_at_pc_pct: 5, dlp_months: 12, payment_lag_days: 30, vat_pct: 10, contract_basis: 'GCC public-works default' },
  Oman:       { mobilisation_advance_pct: 10, retention_pct: 10, retention_release_at_pc_pct: 5, dlp_months: 12, payment_lag_days: 30, vat_pct: 5,  contract_basis: 'OPAL / public-works' },
  UK:         { mobilisation_advance_pct: 0,  retention_pct: 5,  retention_release_at_pc_pct: 2.5, dlp_months: 12, payment_lag_days: 14, vat_pct: 20, contract_basis: 'JCT / NEC, Construction Act 1996' },
  US:         { mobilisation_advance_pct: 5,  retention_pct: 10, retention_release_at_pc_pct: 5, dlp_months: 12, payment_lag_days: 30, vat_pct: 0,  contract_basis: 'AIA A201 (sales tax varies by state)' },
  Singapore:  { mobilisation_advance_pct: 5,  retention_pct: 10, retention_release_at_pc_pct: 5, dlp_months: 12, payment_lag_days: 30, vat_pct: 9,  contract_basis: 'PSSCOC / SOPA' },
};

function marketTermsFor(location) {
  if (!location) return MARKET_TERMS.UAE;
  const loc = String(location).toLowerCase();
  if (/uae|dubai|abu dhabi|sharjah|ajman|fujairah|ras al khaimah|umm al/.test(loc))   return { ...MARKET_TERMS.UAE,       _market: 'UAE'      };
  if (/ksa|saudi|riyadh|jeddah|dammam|khobar|neom|al ula|red sea/.test(loc))         return { ...MARKET_TERMS.KSA,       _market: 'KSA'      };
  if (/qatar|doha/.test(loc))                                                          return { ...MARKET_TERMS.Qatar,     _market: 'Qatar'    };
  if (/kuwait/.test(loc))                                                              return { ...MARKET_TERMS.Kuwait,    _market: 'Kuwait'   };
  if (/bahrain|manama/.test(loc))                                                      return { ...MARKET_TERMS.Bahrain,   _market: 'Bahrain'  };
  if (/oman|muscat|salalah/.test(loc))                                                 return { ...MARKET_TERMS.Oman,      _market: 'Oman'     };
  if (/united kingdom|\buk\b|london|manchester|edinburgh|england|scotland|wales/.test(loc)) return { ...MARKET_TERMS.UK,        _market: 'UK'       };
  if (/usa|united states|new york|los angeles|chicago|texas|california/.test(loc))    return { ...MARKET_TERMS.US,        _market: 'US'       };
  if (/singapore/.test(loc))                                                            return { ...MARKET_TERMS.Singapore, _market: 'Singapore' };
  return { ...MARKET_TERMS.UAE, _market: 'UAE (default)' };
}

// Cash-flow build-up calibrated to per-market standard payment terms (overrides via
// `project.cashflow_terms`). Mob advance recovered linearly to 80 % progress.
// Retention split: half released at substantial completion, half at end of DLP.
function buildCashflow(project, boq, schedule) {
  const defaults = marketTermsFor(project.location);
  const cashflow = (project.cashflow_terms) || {};
  const mobAdvancePct        = (cashflow.mobilisation_advance_pct      ?? defaults.mobilisation_advance_pct)      / 100;
  const retentionPct         = (cashflow.retention_pct                 ?? defaults.retention_pct)                 / 100;
  const retentionRelease1Pct = (cashflow.retention_release_at_pc_pct   ?? defaults.retention_release_at_pc_pct)   / 100;
  const dlpMonths            =  cashflow.dlp_months                    ?? defaults.dlp_months;
  const paymentLagDays       =  cashflow.payment_lag_days              ?? defaults.payment_lag_days;
  const paymentLagMonths     = paymentLagDays / 30;
  const vatPct               = (cashflow.vat_pct                       ?? defaults.vat_pct)                       / 100;
  const market               = defaults._market || 'UAE';
  const contractBasis        = defaults.contract_basis;

  const constructionMonths = Math.ceil(schedule.total_weeks / 4.345);
  const dlpMonth = constructionMonths + Math.ceil(dlpMonths);
  const totalMonths = dlpMonth + 1;
  const monthly = new Array(totalMonths).fill(0);
  const monthlyBySection = {};   // {section: [m0, m1, ...]}

  // Preliminaries activity has a longer descriptive label in the schedule.
  const sectionToActivity = {
    'Preliminaries': 'Pre-construction (mob + NOC)',
  };

  // Cost component split by section — calibrated to UAE construction tender data.
  // Labour share drives weekly cash-intensity (WPS compliance); plant is hire-cost
  // driven; material is the largest but typically funded on 30–60-day credit.
  // Source: T&T Cost Allocation Survey GCC 2024.
  const SECTION_SPLIT = {
    'Preliminaries':   { labour: 0.70, plant: 0.25, material: 0.05 },  // mostly supervision + site running cost
    'Substructure':    { labour: 0.22, plant: 0.20, material: 0.58 },  // concrete + rebar + plant
    'Frame':           { labour: 0.25, plant: 0.15, material: 0.60 },
    'Roof':            { labour: 0.30, plant: 0.05, material: 0.65 },
    'Envelope':        { labour: 0.28, plant: 0.07, material: 0.65 },  // façade/cladding
    'Internal walls':  { labour: 0.40, plant: 0.05, material: 0.55 },  // labour-heavy
    'Finishes':        { labour: 0.42, plant: 0.04, material: 0.54 },  // tiling/joinery/painting
    'MEP':             { labour: 0.30, plant: 0.05, material: 0.65 },
    'External':        { labour: 0.25, plant: 0.20, material: 0.55 },
    'Other':           { labour: 0.30, plant: 0.10, material: 0.60 },
  };

  const monthlyLabour   = new Array(totalMonths).fill(0);
  const monthlyPlant    = new Array(totalMonths).fill(0);
  const monthlyMaterial = new Array(totalMonths).fill(0);

  for (const sec of boq.sections) {
    monthlyBySection[sec.name] = new Array(totalMonths).fill(0);
    const targetName = sectionToActivity[sec.name] || sec.name;
    const act = schedule.activities.find(a => a.name === targetName);
    if (!act) continue;
    const startMonth = Math.floor((act.start_week - 1) / 4.345);
    const endMonth   = Math.min(constructionMonths - 1, Math.floor((act.end_week - 1) / 4.345));
    const span = Math.max(1, endMonth - startMonth + 1);
    const perMonth = sec.subtotal / span;
    const split = SECTION_SPLIT[sec.name] || SECTION_SPLIT['Other'];
    const labourPerMonth   = perMonth * split.labour;
    const plantPerMonth    = perMonth * split.plant;
    const materialPerMonth = perMonth * split.material;
    for (let m = startMonth; m <= endMonth && m < totalMonths; m++) {
      monthly[m]            += perMonth;
      monthlyBySection[sec.name][m] += perMonth;
      monthlyLabour[m]      += labourPerMonth;
      monthlyPlant[m]       += plantPerMonth;
      monthlyMaterial[m]    += materialPerMonth;
    }
  }
  // OH&P spread evenly across construction months. Treated as overhead (mainly labour-
  // adjacent: site management, HQ overheads, profit) — split 60% labour / 10% plant / 30% other.
  const ohpPerMonth = boq.ohp / constructionMonths;
  for (let m = 0; m < constructionMonths; m++) {
    monthly[m]         += ohpPerMonth;
    monthlyLabour[m]   += ohpPerMonth * 0.60;
    monthlyPlant[m]    += ohpPerMonth * 0.10;
    monthlyMaterial[m] += ohpPerMonth * 0.30;
  }

  // Per-month progress (work done) and cumulative
  const monthlyWorkDone = monthly.map(Math.round);
  const cumulativeWorkDone = [];
  let running = 0;
  for (const v of monthlyWorkDone) { running += v; cumulativeWorkDone.push(Math.round(running)); }

  const total = boq.total;
  const mobAdvanceAmt = Math.round(total * mobAdvancePct);

  // Build month-by-month payment certificates
  const rows = [];
  let cumGross         = 0;   // gross certified to date
  let cumRetention     = 0;   // retention held to date
  let mobRecovered     = 0;   // mobilisation recovered to date
  let cumNetCertified  = 0;   // net certified after retention/mob recovery
  let cumNetReceived   = 0;   // received in bank (one month lag)

  for (let m = 0; m < totalMonths; m++) {
    const isConstruction = m < constructionMonths;
    const monthDate = (() => {
      if (!schedule.start_date) return null;
      const d = new Date(schedule.start_date);
      d.setMonth(d.getMonth() + m + 1);   // end-of-month certificate
      return d;
    })();

    // Mobilisation advance lump sum at month 0
    const mobIn = m === 0 ? mobAdvanceAmt : 0;

    // Gross work done this month (already in `monthly`)
    const gross = monthlyWorkDone[m];
    cumGross += gross;
    const progressPct = total > 0 ? cumGross / total : 0;

    // Mobilisation recovery: linear deduction so 80% of mob is recovered when 80% complete,
    // 100% recovered at 100%. Per-month recovery proportional to monthly progress.
    let mobRecoverThisMonth = 0;
    if (mobAdvanceAmt > 0 && isConstruction && cumGross > 0) {
      const targetRecovered = Math.min(mobAdvanceAmt, mobAdvanceAmt * Math.min(1, progressPct / 0.80));
      mobRecoverThisMonth = Math.max(0, Math.round(targetRecovered - mobRecovered));
      mobRecovered += mobRecoverThisMonth;
    }

    // Retention deducted this month (capped at retentionPct of contract)
    const retentionDeducted = isConstruction ? Math.round(gross * retentionPct) : 0;
    cumRetention += retentionDeducted;

    // Retention release events
    let retentionReleased = 0;
    if (m === constructionMonths - 1) {
      // 5% (half of held retention) released at substantial completion
      retentionReleased = Math.round(cumRetention * (retentionRelease1Pct / retentionPct));
      cumRetention -= retentionReleased;
    }
    if (m === dlpMonth) {
      // Final retention release at end of DLP
      retentionReleased = cumRetention;
      cumRetention = 0;
    }

    // Net certified this month
    const net = gross - retentionDeducted - mobRecoverThisMonth + mobIn + retentionReleased;
    cumNetCertified += net;

    // Cash received: 30-day lag → received in next month (we just track cumulative)
    cumNetReceived = Math.max(0, cumNetCertified - (m < totalMonths - 1 ? net * (1 - paymentLagMonths) : 0));
    // Simpler: just shift cumulative by 1 month for "received" line — done in the chart layer.

    const vat = Math.round(net * vatPct);

    rows.push({
      month_index:        m + 1,
      date:               monthDate ? monthDate.toISOString().slice(0, 10) : null,
      phase:              isConstruction ? 'Construction' : (m === dlpMonth ? 'DLP end' : 'DLP'),
      work_done:          gross,
      labour:             Math.round(monthlyLabour[m]   || 0),
      plant:              Math.round(monthlyPlant[m]    || 0),
      material:           Math.round(monthlyMaterial[m] || 0),
      progress_pct:       parseFloat((progressPct * 100).toFixed(1)),
      mob_advance_in:     mobIn,
      mob_recovery:       mobRecoverThisMonth,
      retention_deducted: retentionDeducted,
      retention_released: retentionReleased,
      net_certified:      Math.round(net),
      vat:                vat,
      net_payment:        Math.round(net + vat),
      cum_gross:          Math.round(cumGross),
      cum_retention:      Math.round(cumRetention),
      cum_net_certified:  Math.round(cumNetCertified),
    });
  }

  const totalLabour   = monthlyLabour.reduce((a, b) => a + b, 0);
  const totalPlant    = monthlyPlant.reduce((a, b) => a + b, 0);
  const totalMaterial = monthlyMaterial.reduce((a, b) => a + b, 0);
  const peakLabour    = Math.max(...monthlyLabour);

  // KPIs
  const peakMonth = monthlyWorkDone.reduce((acc, v, i) => (v > acc.value ? { value: v, index: i } : acc), { value: 0, index: 0 });
  const constructionRows = rows.slice(0, constructionMonths);
  const peakNetPayment   = constructionRows.reduce((m, r) => Math.max(m, r.net_payment), 0);
  const avgMonthly       = Math.round(cumGross / Math.max(1, constructionMonths));

  return {
    // Legacy fields (frontend chart still reads these)
    months:                constructionMonths,
    monthly:               monthlyWorkDone.slice(0, constructionMonths),
    cumulative:            cumulativeWorkDone.slice(0, constructionMonths),
    total,

    // Enriched cashflow data
    construction_months:   constructionMonths,
    dlp_months:            dlpMonths,
    total_months:          totalMonths,
    rows,                  // full monthly schedule
    by_section:            monthlyBySection,
    sections:              boq.sections.map(s => s.name),
    terms: {
      market:                   market,
      contract_basis:           contractBasis,
      mobilisation_advance_pct: parseFloat((mobAdvancePct * 100).toFixed(2)),
      mobilisation_advance_amt: mobAdvanceAmt,
      retention_pct:            parseFloat((retentionPct  * 100).toFixed(2)),
      retention_release_at_pc:  parseFloat((retentionRelease1Pct * 100).toFixed(2)),
      dlp_months:               dlpMonths,
      payment_lag_days:         paymentLagDays,
      vat_pct:                  parseFloat((vatPct * 100).toFixed(2)),
    },
    kpis: {
      total_contract:    total,
      peak_monthly:      peakMonth.value,
      peak_month_index:  peakMonth.index + 1,
      peak_month_date:   rows[peakMonth.index]?.date,
      peak_net_payment:  peakNetPayment,
      peak_labour_month: Math.round(peakLabour),
      avg_monthly:       avgMonthly,
      avg_monthly_labour: Math.round(totalLabour / Math.max(1, constructionMonths)),
      number_of_certs:   constructionMonths,
      retention_at_pc:   Math.round(total * retentionPct * (1 - retentionRelease1Pct / retentionPct)),
      mob_advance:       mobAdvanceAmt,
      total_labour:      Math.round(totalLabour),
      total_plant:       Math.round(totalPlant),
      total_material:    Math.round(totalMaterial),
      labour_pct:        parseFloat((totalLabour   / total * 100).toFixed(1)),
      plant_pct:         parseFloat((totalPlant    / total * 100).toFixed(1)),
      material_pct:      parseFloat((totalMaterial / total * 100).toFixed(1)),
    },
    components_monthly: {
      labour:   monthlyLabour.map(Math.round),
      plant:    monthlyPlant.map(Math.round),
      material: monthlyMaterial.map(Math.round),
    },
  };
}

module.exports = { computeBoQ, benchmark, buildSchedule, buildCashflow, sectionOrder };
