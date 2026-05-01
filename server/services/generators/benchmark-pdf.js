// Benchmark Report — PDF.
// Compares the project's AED/m² GFA against published market data
// (T&T, RLB, AECOM, F+G) with elemental breakdown and flag status.

const PDFDocument = require('pdfkit');
const fs = require('fs');

function generate(project, boq, bench, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    // ---- Header ----
    doc.fontSize(20).fillColor('#1a1a1a').text('Benchmark Report');
    doc.fontSize(10).fillColor('#666').text('Independent cost validation against UAE market data — ' + (bench.source?.quarter || 'Q1 2025'));
    doc.moveDown(0.6);

    // ---- Project info ----
    doc.fontSize(9).fillColor('#333');
    const infoRows = [
      ['Project',            project.name || '—'],
      ['Type',               project.projectType || '—'],
      ['Specification',      `${bench.spec_level || 'Standard'} — ${bench.spec_note || ''}`],
      ['Location',           project.location || '—'],
      ['GFA',                `${(boq.gfa || 0).toLocaleString('en-US')} m²`],
      ['Project cost/m²',   `${boq.currency} ${bench.project_cpm.toLocaleString('en-US')}`],
      ['Market mid (${bench.spec_level})', `${boq.currency} ${bench.rlb_mid.toLocaleString('en-US')}`],
    ];
    // Fix the template literal in key
    infoRows[6][0] = `Market mid (${bench.spec_level || 'Standard'})`;
    for (const [k, v] of infoRows) {
      const lineY = doc.y;
      doc.font('Helvetica-Bold').text(k, 50, lineY, { width: 140, lineBreak: false });
      doc.font('Helvetica').text(v, 195, lineY, { width: 350, lineBreak: false });
      doc.text('', 50, lineY + 13);
    }

    // ---- Range bar ----
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#1a1a1a').text('Position vs market range', 50, doc.y);
    doc.moveDown(0.4);

    const barX = 50, barY = doc.y, barW = 495, barH = 26;
    doc.rect(barX, barY, barW, barH).fillAndStroke('#f4f4f4', '#cccccc');

    const range   = bench.rlb_high - bench.rlb_low;
    const cpmPos  = Math.max(0, Math.min(barW, ((bench.project_cpm - bench.rlb_low) / range) * barW));
    const midPos  = ((bench.rlb_mid - bench.rlb_low) / range) * barW;

    // Colour zones: low–mid = light green, mid–high = light amber
    doc.rect(barX, barY, midPos, barH).fill('#e8f6f0');
    doc.rect(barX + midPos, barY, barW - midPos, barH).fill('#fff8e8');
    doc.rect(barX, barY, barW, barH).stroke('#cccccc');
    doc.moveTo(barX + midPos, barY).lineTo(barX + midPos, barY + barH).strokeColor('#aaa').dash(3, { space: 2 }).stroke().undash();

    // Project marker
    const markerX = barX + cpmPos;
    doc.fillColor('#1D9E75').circle(markerX, barY + barH / 2, 7).fill();
    doc.fillColor('#ffffff').fontSize(7).text('●', markerX - 3, barY + barH / 2 - 4, { lineBreak: false });

    // Scale labels
    const labelY = barY + barH + 5;
    doc.fillColor('#1a1a1a').fontSize(8);
    doc.text(`${boq.currency} ${bench.rlb_low.toLocaleString('en-US')}`,  barX,               labelY, { width: 90,  lineBreak: false });
    doc.text(`Mid: ${boq.currency} ${bench.rlb_mid.toLocaleString('en-US')}`, barX + midPos - 40, labelY, { width: 90,  lineBreak: false });
    doc.text(`${boq.currency} ${bench.rlb_high.toLocaleString('en-US')}`, barX + barW - 70,   labelY, { width: 80,  lineBreak: false });
    doc.text('', 50, labelY + 16);
    doc.moveDown(0.6);

    // Position verdict
    const isOver = bench.variance_pct > 0;
    doc.fontSize(11).font('Helvetica-Bold')
      .fillColor(Math.abs(bench.variance_pct) > 15 ? (isOver ? '#a05a00' : '#c0392b') : '#1a1a1a')
      .text(`Position: ${bench.position}`, 50, doc.y);
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).fillColor('#444')
      .text(`Variance vs market mid (${bench.spec_level}): ${isOver ? '+' : ''}${bench.variance_pct}%`, 50, doc.y);

    // ---- Elemental comparison table ----
    doc.moveDown(1.0);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#1a1a1a').text('Elemental cost analysis', 50, doc.y);
    doc.fontSize(9).fillColor('#666').font('Helvetica')
      .text(`Actual cost/m² and % of works compared against ${bench.spec_level} market benchmarks (${bench.source?.quarter || 'Q1 2025'})`, 50, doc.y);
    doc.moveDown(0.4);

    let y = doc.y;
    // Table header
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#555');
    doc.text('Section',            50,  y, { width: 120, lineBreak: false });
    doc.text('Actual %',          170,  y, { width: 55,  align: 'right', lineBreak: false });
    doc.text('Bench range',       225,  y, { width: 80,  align: 'right', lineBreak: false });
    doc.text('Actual AED/m²',    305,  y, { width: 80,  align: 'right', lineBreak: false });
    doc.text('Market AED/m²',    385,  y, { width: 80,  align: 'right', lineBreak: false });
    doc.text('Status',            465,  y, { width: 80,  lineBreak: false });
    y += 13;
    doc.moveTo(50, y).lineTo(545, y).strokeColor('#ccc').lineWidth(0.5).stroke();
    y += 5;

    const flagColour = { 'within range': '#0e7c5a', 'slightly below': '#555', 'slightly above': '#555', 'below range': '#c0392b', 'above range': '#a05a00' };

    doc.fontSize(8.5);
    for (const el of (bench.elemental || [])) {
      if (y > 760) { doc.addPage(); y = 60; }
      const colour = flagColour[el.flag] || '#333';
      doc.font('Helvetica').fillColor('#1a1a1a');
      doc.text(el.name,                                   50,  y, { width: 120, lineBreak: false });
      doc.text(`${el.actual_pct}%`,                      170,  y, { width: 55,  align: 'right', lineBreak: false });
      doc.text(`${el.bench_min_pct}–${el.bench_max_pct}%`, 225, y, { width: 80, align: 'right', lineBreak: false });
      doc.text(el.actual_cpm.toLocaleString('en-US'),    305,  y, { width: 80,  align: 'right', lineBreak: false });
      doc.text(`${el.bench_cpm_low.toLocaleString('en-US')} – ${el.bench_cpm_high.toLocaleString('en-US')}`, 385, y, { width: 80, align: 'right', lineBreak: false });
      doc.font('Helvetica-Bold').fillColor(colour);
      doc.text(el.flag,                                  465,  y, { width: 80,  lineBreak: false });
      y += 15;
    }

    // If no elemental data
    if (!bench.elemental || bench.elemental.length === 0) {
      doc.font('Helvetica-Oblique').fillColor('#999').fontSize(9)
        .text('No approved elements found. Analyse drawings first to generate elemental breakdown.', 50, y);
      y += 20;
    }

    // ---- Totals row ----
    y += 4;
    doc.moveTo(50, y).lineTo(545, y).strokeColor('#999').lineWidth(0.5).stroke();
    y += 6;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a1a');
    doc.text('Total contract value',           50,  y, { width: 120, lineBreak: false });
    doc.text('',                              170,  y, { width: 55,  lineBreak: false });
    doc.text('',                              225,  y, { width: 80,  lineBreak: false });
    doc.text(bench.project_cpm.toLocaleString('en-US'), 305, y, { width: 80, align: 'right', lineBreak: false });
    doc.text(`${bench.rlb_low.toLocaleString('en-US')} – ${bench.rlb_high.toLocaleString('en-US')}`, 385, y, { width: 80, align: 'right', lineBreak: false });
    doc.fillColor(Math.abs(bench.variance_pct) > 15 ? '#a05a00' : '#0e7c5a')
      .text(`${bench.variance_pct > 0 ? '+' : ''}${bench.variance_pct}% vs mid`, 465, y, { width: 80, lineBreak: false });

    // ---- Source attribution footer ----
    doc.text('', 50, y + 24);
    doc.moveDown(0.8);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').lineWidth(0.5).stroke();
    doc.moveDown(0.3);
    doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#888');
    const src = bench.source || {};
    doc.text(`Data sources: ${src.attribution || 'T&T · RLB · AECOM · F+G'}`, 50, doc.y, { width: 495 });
    doc.text(`Basis: ${src.basis || 'Construction cost/m² GFA — excludes land, VAT (5%), professional fees, client contingency'}`, 50, doc.y, { width: 495 });
    doc.text(`Market: ${src.market || 'UAE, Dubai base'} · ${src.quarter || 'Q1 2025'} · Ranges represent competitively bid contracts ±15% for negotiated/bespoke works`, 50, doc.y, { width: 495 });
    doc.moveDown(0.3);
    doc.text(`Generated by Halford AI QS Workbench at ${new Date().toISOString()}`, 50, doc.y, { width: 495 });

    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

module.exports = { generate };
