// Variation Report PDF — shows the cost-impact of revised drawings against the
// approved BoQ baseline. When project.variations is populated (from a delta
// upload), it produces a real variation order. Otherwise it produces a register
// template ready to be appended.

const PDFDocument = require('pdfkit');
const fs = require('fs');

function generate(project, boq, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    doc.fontSize(20).text('Variation Report');
    doc.fontSize(10).fillColor('#666').text('Drawing-delta cost impact analysis');
    doc.moveDown(0.6);

    doc.fontSize(9).fillColor('#333');
    [
      ['Project', project.name || '—'],
      ['Baseline (approved)', `${boq.currency} ${boq.total.toLocaleString('en-US')}`],
      ['Variation register', project.variations?.length ? `${project.variations.length} item(s)` : 'Empty — no variations recorded'],
    ].forEach(([k, v]) => {
      doc.font('Helvetica-Bold').text(k, doc.x, doc.y, { continued: true, width: 130 });
      doc.font('Helvetica').text('  ' + v);
    });

    const variations = project.variations || [];
    let totalAdds = 0, totalOmits = 0;
    variations.forEach(v => { if (v.amount > 0) totalAdds += v.amount; else totalOmits += Math.abs(v.amount); });
    const net = totalAdds - totalOmits;

    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#1a1a1a').text('Summary');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);
    doc.text(`Additions: ${boq.currency} ${totalAdds.toLocaleString('en-US')}`);
    doc.text(`Omissions: ${boq.currency} ${totalOmits.toLocaleString('en-US')}`);
    doc.font('Helvetica-Bold').fillColor(net > 0 ? '#a05a00' : '#0e7c5a');
    doc.text(`Net variation: ${net >= 0 ? '+' : ''}${boq.currency} ${net.toLocaleString('en-US')} (${((net / boq.total) * 100).toFixed(1)}% of baseline)`);
    doc.fillColor('#1a1a1a');
    doc.font('Helvetica').text(`Revised contract value: ${boq.currency} ${(boq.total + net).toLocaleString('en-US')}`);

    doc.moveDown(1.2);
    doc.font('Helvetica-Bold').fontSize(13).text('Variation register');
    doc.moveDown(0.3);

    let y = doc.y;
    const cols = [
      { label: 'VO #',        x: 50,  w: 50 },
      { label: 'Description', x: 100, w: 220 },
      { label: 'Drawing ref', x: 320, w: 90 },
      { label: 'Type',        x: 410, w: 60 },
      { label: 'Amount',      x: 470, w: 80, align: 'right' },
    ];
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#666');
    cols.forEach(c => doc.text(c.label, c.x, y, { width: c.w, align: c.align || 'left' }));
    y += 14;
    doc.moveTo(50, y).lineTo(550, y).strokeColor('#ccc').stroke();
    y += 4;

    doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a');

    if (!variations.length) {
      doc.font('Helvetica-Oblique').fillColor('#888');
      doc.text('No variations recorded yet. Upload revised drawings via the Variation Upload modal to populate this register automatically.', 50, y, { width: 500 });
    } else {
      variations.forEach((v, i) => {
        if (y > 760) { doc.addPage(); y = 60; }
        doc.font('Helvetica');
        doc.text(`VO-${String(i + 1).padStart(3, '0')}`, cols[0].x, y, { width: cols[0].w });
        doc.text(v.description || '—', cols[1].x, y, { width: cols[1].w });
        doc.text(v.drawing_ref || '—', cols[2].x, y, { width: cols[2].w });
        doc.text(v.amount > 0 ? 'Addition' : 'Omission', cols[3].x, y, { width: cols[3].w });
        doc.fillColor(v.amount > 0 ? '#a05a00' : '#0e7c5a');
        doc.text(`${v.amount >= 0 ? '+' : ''}${boq.currency} ${Math.abs(v.amount).toLocaleString('en-US')}`, cols[4].x, y, { width: cols[4].w, align: 'right' });
        doc.fillColor('#1a1a1a');
        y += 16;
      });
    }

    // Methodology page
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#1a1a1a').text('Methodology');
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(10).fillColor('#333');
    doc.text('Variation amounts are computed by re-running AI takeoff on the revised drawing set, then diffing the resulting BoQ against the approved baseline:', { paragraphGap: 6 });
    doc.text('  1.  Revised drawings are uploaded and parsed via Autodesk APS (Model Derivative).', { paragraphGap: 4 });
    doc.text('  2.  Claude Opus 4.7 extracts elements from the new geometry using the same rate library.', { paragraphGap: 4 });
    doc.text('  3.  Element codes are joined to the baseline; unchanged lines are filtered out.', { paragraphGap: 4 });
    doc.text('  4.  Net additions/omissions are priced at the contract rates and reported as VO line items.', { paragraphGap: 4 });
    doc.moveDown(0.6);
    doc.text('All amounts shown are pre-OH&P. Final variation is subject to QS review and contract administrator approval.');

    doc.moveDown(2);
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#666');
    doc.text(`Generated by Halford AI QS Workbench at ${new Date().toISOString()}`);

    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

module.exports = { generate };
