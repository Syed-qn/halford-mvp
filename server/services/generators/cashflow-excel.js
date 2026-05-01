// Cost-loaded schedule / Cash-flow S-curve — Excel export.
// Monthly planned spend + cumulative + ratios for drawdown forecasting.

const ExcelJS = require('exceljs');

async function generate(project, boq, schedule, cashflow, outputPath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Halford AI QS Workbench';

  const sh = wb.addWorksheet('Cash flow');
  sh.columns = [
    { header: 'Month',                key: 'month',     width: 10 },
    { header: 'Period',               key: 'period',    width: 14 },
    { header: 'Planned monthly',      key: 'monthly',   width: 18, style: { numFmt: '#,##0' } },
    { header: 'Cumulative planned',   key: 'cum',       width: 20, style: { numFmt: '#,##0' } },
    { header: '% of total',           key: 'pct',       width: 12, style: { numFmt: '0.0%' } },
    { header: 'Drawdown',             key: 'drawdown',  width: 14, style: { numFmt: '0.0%' } },
  ];
  sh.getRow(1).font = { bold: true };
  sh.getRow(1).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } }; });

  const startDate = new Date(schedule.start_date);
  for (let i = 0; i < cashflow.months; i++) {
    const d = new Date(startDate);
    d.setMonth(d.getMonth() + i);
    sh.addRow({
      month: `M${i + 1}`,
      period: d.toISOString().slice(0, 7),
      monthly: cashflow.monthly[i],
      cum: cashflow.cumulative[i],
      pct: cashflow.monthly[i] / cashflow.total,
      drawdown: cashflow.cumulative[i] / cashflow.total,
    });
  }

  // Totals row
  sh.addRow({});
  const tot = sh.addRow({ period: 'TOTAL', monthly: cashflow.total });
  tot.font = { bold: true };
  tot.eachCell(c => c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D9E75' } });
  tot.eachCell(c => c.font = { bold: true, color: { argb: 'FFFFFFFF' } });

  // ---- Resource sheet — labour-hours per section ----
  const res = wb.addWorksheet('Resources');
  res.columns = [
    { header: 'Activity',     key: 'activity',  width: 28 },
    { header: 'Start week',   key: 'start',     width: 12 },
    { header: 'Duration (wk)',key: 'dur',       width: 14 },
    { header: 'Labour hours', key: 'hrs',       width: 14, style: { numFmt: '#,##0' } },
    { header: 'Cost',         key: 'cost',      width: 18, style: { numFmt: '#,##0' } },
  ];
  res.getRow(1).font = { bold: true };
  res.getRow(1).eachCell(c => c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } });
  for (const a of schedule.activities) {
    const sec = boq.sections.find(s => s.name === a.name);
    res.addRow({ activity: a.name, start: a.start_week, dur: a.duration, hrs: a.labour_hrs, cost: sec ? sec.subtotal : 0 });
  }

  await wb.xlsx.writeFile(outputPath);
  return outputPath;
}

module.exports = { generate };
