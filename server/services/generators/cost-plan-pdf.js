// Cost Plan — PDF. Elemental breakdown by RIBA stages, cost/m² per element,
// with a one-page executive summary.

const PDFDocument = require('pdfkit');
const fs = require('fs');

function generate(project, boq, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    // ---- Header ----
    doc.fontSize(20).fillColor('#1a1a1a').text('Cost Plan', { align: 'left' });
    doc.fontSize(10).fillColor('#666').text('Halford AI QS Workbench — Stage 3 Spatial Coordination', { align: 'left' });
    doc.moveDown(0.5);

    // Project info box
    doc.fontSize(9).fillColor('#333');
    doc.moveDown();
    const labelW = 110;
    [
      ['Project',       project.name || '—'],
      ['Type',          project.projectType || '—'],
      ['Location',      project.location || '—'],
      ['GFA',           `${(boq.gfa || 0).toLocaleString('en-US')} m²`],
      ['Currency',      boq.currency],
      ['Cost per m²',   `${boq.currency} ${boq.cost_per_m2.toLocaleString('en-US')}`],
      ['Generated',     new Date().toISOString().slice(0, 19).replace('T', ' ')],
    ].forEach(([k, v]) => {
      doc.font('Helvetica-Bold').text(k, doc.x, doc.y, { continued: true, width: labelW });
      doc.font('Helvetica').text('  ' + v);
    });

    doc.moveDown(1.2);
    doc.font('Helvetica-Bold').fontSize(13).text('Elemental breakdown');
    doc.moveDown(0.3);

    // Table header
    const startX = 50;
    let y = doc.y;
    const cols = [
      { label: 'Section',     x: startX,        w: 130 },
      { label: 'Cost',        x: startX + 130,  w: 90, align: 'right' },
      { label: 'Cost/m²',     x: startX + 220,  w: 80, align: 'right' },
      { label: '% of works',  x: startX + 300,  w: 70, align: 'right' },
      { label: 'Items',       x: startX + 370,  w: 50, align: 'right' },
      { label: 'Avg conf.',   x: startX + 420,  w: 70, align: 'right' },
    ];
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#666');
    cols.forEach(c => doc.text(c.label, c.x, y, { width: c.w, align: c.align || 'left' }));
    y += 14;
    doc.moveTo(startX, y).lineTo(startX + 490, y).strokeColor('#cccccc').lineWidth(0.5).stroke();
    y += 4;

    doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a');
    for (const sec of boq.sections) {
      const cpm = boq.gfa ? Math.round(sec.subtotal / boq.gfa) : 0;
      const pct = ((sec.subtotal / boq.subtotal) * 100).toFixed(1) + '%';
      const avgConf = Math.round(sec.items.reduce((s, i) => s + (i.confidence || 0), 0) / Math.max(1, sec.items.length));
      doc.text(sec.name, cols[0].x, y, { width: cols[0].w });
      doc.text(`${boq.currency} ${sec.subtotal.toLocaleString('en-US')}`, cols[1].x, y, { width: cols[1].w, align: 'right' });
      doc.text(cpm.toLocaleString('en-US'), cols[2].x, y, { width: cols[2].w, align: 'right' });
      doc.text(pct, cols[3].x, y, { width: cols[3].w, align: 'right' });
      doc.text(String(sec.items.length), cols[4].x, y, { width: cols[4].w, align: 'right' });
      doc.text(`${avgConf}%`, cols[5].x, y, { width: cols[5].w, align: 'right' });
      y += 18;
    }

    y += 6;
    doc.moveTo(startX, y).lineTo(startX + 490, y).strokeColor('#999').lineWidth(0.5).stroke();
    y += 6;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Subtotal (works)', cols[0].x, y); doc.text(`${boq.currency} ${boq.subtotal.toLocaleString('en-US')}`, cols[1].x, y, { width: cols[1].w, align: 'right' });
    y += 16;
    doc.font('Helvetica').text(`OH&P @ ${boq.markup_pct}%`, cols[0].x, y); doc.text(`${boq.currency} ${boq.ohp.toLocaleString('en-US')}`, cols[1].x, y, { width: cols[1].w, align: 'right' });
    y += 16;
    doc.font('Helvetica-Bold').fontSize(11);
    doc.fillColor('#1D9E75');
    doc.text('Total contract value', cols[0].x, y);
    doc.text(`${boq.currency} ${boq.total.toLocaleString('en-US')}`, cols[1].x, y, { width: cols[1].w, align: 'right' });
    doc.fillColor('#1a1a1a');

    // ---- New page: detailed line items per section ----
    for (const sec of boq.sections) {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(14).text(sec.name);
      doc.font('Helvetica').fontSize(9).fillColor('#666').text(`${sec.items.length} items · ${boq.currency} ${sec.subtotal.toLocaleString('en-US')}`);
      doc.moveDown(0.6);
      doc.fillColor('#1a1a1a').fontSize(8);
      let yy = doc.y;
      doc.font('Helvetica-Bold');
      doc.text('Code', 50, yy, { width: 60 });
      doc.text('Description', 110, yy, { width: 240 });
      doc.text('Qty', 350, yy, { width: 50, align: 'right' });
      doc.text('Unit', 400, yy, { width: 30 });
      doc.text('Rate', 430, yy, { width: 50, align: 'right' });
      doc.text('Total', 480, yy, { width: 70, align: 'right' });
      yy += 12;
      doc.moveTo(50, yy).lineTo(550, yy).strokeColor('#ccc').stroke();
      yy += 4;
      doc.font('Helvetica');
      for (const it of sec.items) {
        if (yy > 780) { doc.addPage(); yy = 60; }
        doc.text(it.code, 50, yy, { width: 60 });
        doc.text(it.desc, 110, yy, { width: 240 });
        doc.text(String(it.qty), 350, yy, { width: 50, align: 'right' });
        doc.text(it.unit, 400, yy, { width: 30 });
        doc.text(it.rate.toLocaleString('en-US'), 430, yy, { width: 50, align: 'right' });
        doc.text(it.extended.toLocaleString('en-US'), 480, yy, { width: 70, align: 'right' });
        yy += 14;
      }
    }

    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

module.exports = { generate };
