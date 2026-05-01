// Scenario Engine — Time-Cost Trade-Off (TCT) analysis for UAE construction projects.
//
// For each scenario (optimal / accelerated / economy / milestone-locked) we compute:
//   • Duration (weeks)         — bounded by physical minimum (NOC + cure + steel/MEP lead)
//   • Direct cost              — base BoQ + acceleration premium for compression
//   • Indirect cost            — preliminaries flow rate × duration
//   • OH&P                     — main contractor's overheads & profit (from project)
//   • Risk reserve             — P50→P90 band; widens for compressed scenarios
//   • Peak crew                — derived from labour hours / duration
//   • Peak weekly spend        — front-loaded (1.4× peaking factor)
//   • Constraint compliance    — checks NOC, cure lag, steel/MEP lead, max crew, target, spend cap
//   • Critical path            — longest dependency chain through schedule
//
// Calibration (UAE Q1 2025 market):
//   • Indirect cost flow:        0.35 % of project value per week (preliminaries on site)
//   • Acceleration premium:      0.30 % direct cost premium per 1 % schedule compression
//   • Crash floor:               70 % of natural duration (industry max compression)
//   • Risk reserve baseline:     5 % of project, scaled up for crashed scenarios
//   • Peak weekly spend factor:  1.4× average (S-curve peak)
//   • Crew utilisation factor:   70 % (non-productive time, breaks, weather)

const { buildSchedule } = require('./pricing');

const INDIRECT_RATE_PER_WEEK      = 0.0035;
const ACCELERATION_PREMIUM_PER_PCT = 0.003;
const MIN_CRASH_RATIO             = 0.70;
const RISK_RESERVE_BASE           = 0.05;
const PEAK_SPEND_FACTOR           = 1.4;
const CREW_UTILISATION            = 0.70;

function computeScenario(project, boq, strategy) {
  const c = project.constraints || {};
  const nocWeeks       = c.noc_weeks || 0;
  const cureLagWeeks   = Math.ceil((c.cure_lag_days || 28) / 7);
  const steelLeadWeeks = c.steel_lead_weeks || 12;
  const mepLeadWeeks   = c.mep_lead_weeks || 16;
  const targetWeeks    = c.target_weeks || 104;
  const maxCrews       = c.max_crews || 12;
  const baseWorkdays   = c.workdays_per_week || 6;
  const maxWeeklySpend = c.max_weekly_spend || null;

  // Run buildSchedule to get the natural (unconstrained) duration & critical chain.
  const baseSchedule = buildSchedule(project, boq);
  const naturalDur   = baseSchedule.natural_weeks || baseSchedule.total_weeks;

  // Physical minimum: cannot compress below the gating predecessor chain.
  // (NOC) + max(steel lead, MEP lead, cure lag) + minimum execution window of ~45% of natural.
  const physicalMin = Math.max(
    nocWeeks + steelLeadWeeks + Math.ceil(naturalDur * 0.40),
    nocWeeks + mepLeadWeeks   + Math.ceil(naturalDur * 0.35),
    nocWeeks + cureLagWeeks   + Math.ceil(naturalDur * 0.45),
    Math.ceil(naturalDur * MIN_CRASH_RATIO)
  );

  // Strategy → target duration + crew config
  let targetDur, label, badge, crews, workdays, description;
  switch (strategy) {
    case 'optimal': {
      // U-curve minimum: where d(direct)/dt + d(indirect)/dt = 0
      // direct premium = ACCELERATION_PREMIUM_PER_PCT × 100 % per week of compression
      // indirect rate  = INDIRECT_RATE_PER_WEEK per week of duration
      // optimal compression % = INDIRECT_RATE_PER_WEEK / (ACCELERATION_PREMIUM_PER_PCT × 100)
      const optimalCompression = Math.min(0.15, INDIRECT_RATE_PER_WEEK / (ACCELERATION_PREMIUM_PER_PCT * 100));
      targetDur   = Math.max(physicalMin, Math.round(naturalDur * (1 - optimalCompression)));
      label       = 'Optimal — total cost minimised';
      description = 'Time-cost trade-off optimum. Duration where marginal acceleration premium equals marginal preliminaries saving.';
      badge       = 'Optimal';
      crews       = maxCrews;
      workdays    = baseWorkdays;
      break;
    }
    case 'fastest': {
      targetDur   = physicalMin;
      label       = 'Accelerated — maximum compression';
      description = 'Crashed to the physical minimum: NOC, long-lead procurement, and cure-lag predecessors enforced. Premium for double-shift labour, extended plant hire and acceleration risk.';
      badge       = 'Fastest';
      crews       = Math.ceil(maxCrews * 1.5);
      workdays    = 7;
      break;
    }
    case 'cheapest': {
      // Extend up to +30% of natural duration; beyond that supervision/site overhead breaks
      // even with savings (people demobilise and remobilise).
      targetDur   = Math.min(targetWeeks, Math.round(naturalDur * 1.30));
      label       = 'Economy — extended programme';
      description = 'Slowed to reduce peak crew and avoid acceleration. Beyond +30% of natural duration, indirect (preliminaries) cost dominates and total cost rises again.';
      badge       = 'Lowest direct';
      crews       = Math.max(4, Math.floor(maxCrews * 0.7));
      workdays    = Math.min(baseWorkdays, 5);
      break;
    }
    case 'milestone': {
      targetDur   = Math.min(targetWeeks, Math.max(physicalMin, naturalDur));
      label       = `Milestone-locked — ${targetWeeks} wk target`;
      description = `Hit the contractual ${targetWeeks}-week completion. Duration capped at target; resourcing flexed to meet milestone.`;
      badge       = '';
      crews       = maxCrews;
      workdays    = baseWorkdays;
      break;
    }
    default:
      targetDur = naturalDur;
      label = 'Baseline';
      description = '';
      badge = '';
      crews = maxCrews;
      workdays = baseWorkdays;
  }

  // ---- Cost build-up ----
  // Compression % below natural duration drives the direct-cost acceleration premium.
  const compressionPct = Math.max(0, (naturalDur - targetDur) / naturalDur);
  const accelerationPct = compressionPct * 100 * ACCELERATION_PREMIUM_PER_PCT;
  const directCost   = Math.round(boq.subtotal * (1 + accelerationPct));
  const ohp          = boq.ohp || 0;
  const indirectCost = Math.round((boq.total || boq.subtotal) * INDIRECT_RATE_PER_WEEK * targetDur);
  // Risk reserve grows with compression (P90 - P50 widens for crashed schedules).
  const riskReserve  = Math.round((boq.total || boq.subtotal) * RISK_RESERVE_BASE * (1 + compressionPct * 1.5));
  const total        = directCost + ohp + indirectCost + riskReserve;

  // ---- Resource & cash flow checks ----
  const totalLabourHrs = baseSchedule.total_labour_hrs || 0;
  const hoursPerWeek   = workdays * 8 * CREW_UTILISATION;
  const peakCrew       = totalLabourHrs > 0
    ? Math.ceil(totalLabourHrs / Math.max(1, targetDur * hoursPerWeek))
    : crews;
  const peakWeeklySpend = Math.round(total / targetDur * PEAK_SPEND_FACTOR);

  // ---- Constraint validation ----
  const violations = [];
  if (targetDur < physicalMin) {
    violations.push({
      check:  'Physical minimum',
      detail: `${targetDur} wk < physical minimum ${physicalMin} wk (NOC ${nocWeeks} + steel/MEP lead + minimum execution)`,
    });
  }
  if (peakCrew > maxCrews * 1.05) {
    violations.push({
      check:  'Resource capacity',
      detail: `Peak crew demand ${peakCrew} exceeds site limit ${maxCrews}`,
    });
  }
  if (maxWeeklySpend && peakWeeklySpend > maxWeeklySpend * 1.05) {
    violations.push({
      check:  'Cash-flow ceiling',
      detail: `Peak weekly spend AED ${peakWeeklySpend.toLocaleString('en-US')} exceeds cap AED ${maxWeeklySpend.toLocaleString('en-US')}`,
    });
  }
  if (targetDur > targetWeeks) {
    violations.push({
      check:  'Target completion',
      detail: `Duration ${targetDur} wk exceeds contract target ${targetWeeks} wk`,
    });
  }

  // ---- Critical path (longest chain through buildSchedule output) ----
  // The chain that drives total duration: pre-construction → substructure → frame → envelope → internal walls → finishes → commissioning → handover.
  // External works runs in parallel and is not normally critical.
  const criticalPath = [
    `Pre-construction & NOC (${nocWeeks} wk)`,
    'Substructure',
    `Frame (gated by ${Math.max(cureLagWeeks, steelLeadWeeks)} wk cure/steel lead)`,
    'Envelope',
    'Internal walls',
    'Finishes',
    `MEP (gated by ${mepLeadWeeks} wk equipment lead)`,
    'Commissioning',
    'Handover',
  ];

  return {
    label,
    description,
    badge,
    strategy,

    duration_weeks:    targetDur,
    natural_weeks:     naturalDur,
    physical_min_weeks: physicalMin,
    compression_pct:   parseFloat((compressionPct * 100).toFixed(1)),
    target_weeks:      targetWeeks,

    cost:              total,
    cost_breakdown: {
      direct:   directCost,
      ohp,
      indirect: indirectCost,
      risk:     riskReserve,
    },
    acceleration_premium_pct: parseFloat((accelerationPct * 100).toFixed(2)),

    crews,
    workdays_per_week: workdays,
    peak_crew:         peakCrew,
    peak_weekly_spend: peakWeeklySpend,
    max_weekly_spend:  maxWeeklySpend,
    max_crews:         maxCrews,

    critical_path:     criticalPath,
    constraints_passed: violations.length === 0,
    violations,

    // Probabilistic confidence band — narrower for natural duration, widens with compression.
    p10: Math.round(total * (0.96 - compressionPct * 0.05)),
    p50: total,
    p90: Math.round(total * (1.05 + compressionPct * 1.0)),
  };
}

function computeAllScenarios(project, boq) {
  return [
    computeScenario(project, boq, 'optimal'),
    computeScenario(project, boq, 'fastest'),
    computeScenario(project, boq, 'cheapest'),
    computeScenario(project, boq, 'milestone'),
  ];
}

module.exports = { computeScenario, computeAllScenarios };
