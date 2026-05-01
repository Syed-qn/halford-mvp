// Priced BoQ — Excel. Sectioned (NRM2-style), with formulas, styled header,
// and a summary tab. Output: real .xlsx that opens in Excel/Numbers/LibreOffice.

const ExcelJS = require('exceljs');

async function generate(project, boq, outputPath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Halford AI QS Workbench';
  wb.created = new Date();

  // ---- Cover sheet ----
  const cover = wb.addWorksheet('Project Info');
  cover.columns = [{ width: 28 }, { width: 60 }];
  const info = [
    ['Project name', project.name || '—'],
    ['Project type', project.projectType || '—'],
    ['Location', project.location || '—'],
    ['Currency', boq.currency],
    ['GFA (m²)', boq.gfa],
    ['Cost per m²', `${boq.currency} ${boq.cost_per_m2.toLocaleString('en-US')}`],
    ['Location factor', boq.location_factor],
    ['Project type factor', boq.project_type_factor],
    ['Markup (OH&P)', `${boq.markup_pct}%`],
    ['Generated', new Date().toISOString().slice(0, 19).replace('T', ' ')],
    ['Source', 'Halford AI takeoff (Claude Opus 4.7 + Autodesk Platform Services)'],
  ];
  for (const [k, v] of info) {
    const row = cover.addRow([k, v]);
    row.getCell(1).font = { bold: true };
  }
  cover.getRow(1).font = { bold: true, size: 14 };

  // ---- Summary sheet ----
  const summary = wb.addWorksheet('Summary');
  summary.columns = [
    { header: 'Section', key: 'section', width: 30 },
    { header: 'Subtotal', key: 'subtotal', width: 18, style: { numFmt: '#,##0' } },
    { header: '% of works', key: 'pct', width: 12, style: { numFmt: '0.0%' } },
  ];
  for (const sec of boq.sections) {
    summary.addRow({ section: sec.name, subtotal: sec.subtotal, pct: sec.subtotal / boq.subtotal });
  }
  summary.addRow({});
  const sumRow = summary.addRow({ section: 'Subtotal (works)', subtotal: boq.subtotal });
  const ohpRow = summary.addRow({ section: `OH&P (${boq.markup_pct}%)`, subtotal: boq.ohp });
  const totalRow = summary.addRow({ section: 'Total contract value', subtotal: boq.total });
  [sumRow, ohpRow, totalRow].forEach(r => r.font = { bold: true });
  totalRow.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D9E75' } }; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
  summary.getRow(1).font = { bold: true };

  // ---- Detail sheet (sectioned BoQ) ----
  const detail = wb.addWorksheet('Priced BoQ');
  detail.columns = [
    { header: 'Code', key: 'code', width: 14 },
    { header: 'Description', key: 'desc', width: 56 },
    { header: 'Discipline', key: 'discipline', width: 14 },
    { header: 'Qty', key: 'qty', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Unit', key: 'unit', width: 8 },
    { header: 'Rate', key: 'rate', width: 14, style: { numFmt: '#,##0' } },
    { header: 'Extended', key: 'extended', width: 16, style: { numFmt: '#,##0' } },
    { header: 'Confidence', key: 'confidence', width: 12, style: { numFmt: '0' } },
    { header: 'Source drawing', key: 'source', width: 22 },
  ];
  detail.getRow(1).font = { bold: true };
  detail.getRow(1).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } }; });
  detail.views = [{ state: 'frozen', ySplit: 1 }];

  for (const sec of boq.sections) {
    const headerRow = detail.addRow({ code: sec.name.toUpperCase() });
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.eachCell(c => c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF333333' } });

    for (const it of sec.items) {
      const row = detail.addRow({
        code: it.code,
        desc: it.desc,
        discipline: it.discipline,
        qty: it.qty,
        unit: it.unit,
        rate: it.rate,
        extended: { formula: `D${detail.lastRow.number + 0}*F${detail.lastRow.number + 0}` },
        confidence: it.confidence,
        source: it.source,
      });
      // Re-set extended with the actual row number
      row.getCell('extended').value = { formula: `D${row.number}*F${row.number}` };
      if (it.flagged) {
        row.getCell('confidence').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE7B5' } };
      }
    }

    const subRow = detail.addRow({
      desc: `${sec.name} subtotal`,
      extended: sec.subtotal,
    });
    subRow.font = { bold: true };
    subRow.eachCell(c => c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F3F3' } });
    detail.addRow({});
  }

  detail.addRow({});
  const subT = detail.addRow({ desc: 'Subtotal (works)', extended: boq.subtotal });
  const ohpT = detail.addRow({ desc: `OH&P @ ${boq.markup_pct}%`, extended: boq.ohp });
  const totT = detail.addRow({ desc: 'Total contract value', extended: boq.total });
  [subT, ohpT, totT].forEach(r => r.font = { bold: true });
  totT.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D9E75' } }; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });

  await wb.xlsx.writeFile(outputPath);
  return outputPath;
}

module.exports = { generate };
