// Tender Review PDF — produces a tender-ready package showing the priced BoQ
// alongside review fields for contractor submissions. When a contractor BoQ has
// been uploaded (project.tender_submission), it diffs line-by-line.

const PDFDocument = require('pdfkit');
const fs = require('fs');

function generate(project, boq, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    doc.fontSize(20).text('Tender Review');
    doc.fontSize(10).fillColor('#666').text('AI-assisted comparison: estimate vs contractor BoQ');
    doc.moveDown(0.6);

    doc.fontSize(9).fillColor('#333');
    [
      ['Project', project.name || '—'],
      ['Type', project.projectType || '—'],
      ['Estimate total', `${boq.currency} ${boq.total.toLocaleString('en-US')}`],
      ['Subtotal (works)', `${boq.currency} ${boq.subtotal.toLocaleString('en-US')}`],
      [`OH&P @ ${boq.markup_pct}%`, `${boq.currency} ${boq.ohp.toLocaleString('en-US')}`],
    ].forEach(([k, v]) => {
      doc.font('Helvetica-Bold').text(k, doc.x, doc.y, { continued: true, width: 130 });
      doc.font('Helvetica').text('  ' + v);
    });

    const submission = project.tender_submission || null;

    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#1a1a1a').text('Comparison summary');
    doc.moveDown(0.3);

    if (submission) {
      // Variance
      const variance = submission.total - boq.total;
      const variancePct = ((variance / boq.total) * 100).toFixed(1);
      doc.font('Helvetica').fontSize(10);
      doc.text(`Contractor: ${submission.contractor || 'Submitted bid'}`);
      doc.text(`Bid total: ${boq.currency} ${submission.total.toLocaleString('en-US')}`);
      doc.fillColor(variance > 0 ? '#a05a00' : '#0e7c5a');
      doc.text(`Variance: ${variance > 0 ? '+' : ''}${boq.currency} ${variance.toLocaleString('en-US')} (${variance > 0 ? '+' : ''}${variancePct}%)`);
      doc.fillColor('#1a1a1a');
    } else {
      doc.font('Helvetica-Oblique').fontSize(10).fillColor('#666');
      doc.text('No contractor BoQ uploaded yet. This document is a tender package — share with bidders, then upload their priced BoQ to enable AI variance analysis.');
      doc.fillColor('#1a1a1a');
    }

    doc.moveDown(1.2);
    doc.font('Helvetica-Bold').fontSize(13).text('Section-level review');
    doc.moveDown(0.3);

    let y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#666');
    const cols = [
      { label: 'Section',     x: 50,  w: 130 },
      { label: 'Estimate',    x: 180, w: 90, align: 'right' },
      { label: 'Bid',         x: 270, w: 90, align: 'right' },
      { label: 'Variance',    x: 360, w: 80, align: 'right' },
      { label: 'Review note', x: 440, w: 110 },
    ];
    cols.forEach(c => doc.text(c.label, c.x, y, { width: c.w, align: c.align || 'left' }));
    y += 14;
    doc.moveTo(50, y).lineTo(550, y).strokeColor('#ccc').stroke();
    y += 4;

    doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a');
    for (const sec of boq.sections) {
      const subBid = submission?.sections?.[sec.name];
      const v = subBid != null ? subBid - sec.subtotal : null;
      const note = v == null ? '— pending —' : v > sec.subtotal * 0.1 ? 'High variance — review' : v < -sec.subtotal * 0.1 ? 'Below estimate — verify scope' : 'Within tolerance';
      doc.text(sec.name, cols[0].x, y, { width: cols[0].w });
      doc.text(`${boq.currency} ${sec.subtotal.toLocaleString('en-US')}`, cols[1].x, y, { width: cols[1].w, align: 'right' });
      doc.text(subBid != null ? `${boq.currency} ${subBid.toLocaleString('en-US')}` : '—', cols[2].x, y, { width: cols[2].w, align: 'right' });
      if (v != null) {
        doc.fillColor(v > 0 ? '#a05a00' : v < 0 ? '#0e7c5a' : '#1a1a1a');
        doc.text(`${v > 0 ? '+' : ''}${v.toLocaleString('en-US')}`, cols[3].x, y, { width: cols[3].w, align: 'right' });
        doc.fillColor('#1a1a1a');
      } else {
        doc.text('—', cols[3].x, y, { width: cols[3].w, align: 'right' });
      }
      doc.text(note, cols[4].x, y, { width: cols[4].w });
      y += 16;
    }

    // Tender clauses page
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#1a1a1a').text('Standard tender clauses');
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(10).fillColor('#333');
    const clauses = [
      'Bidders shall price each item in the BoQ separately. Unpriced items will be deemed to be included in other items.',
      'Quantities shown are estimated and may vary in execution; payment shall be on measured work.',
      'Bidders to declare any preliminaries, OH&P, and contingency separately from the works subtotal.',
      'Bidders to confirm rate validity for 90 days from submission.',
      'Bidders shall be deemed to have visited the site, examined the drawings, and satisfied themselves as to the nature of the works.',
      'Submissions shall include programme, method statement, and CV of proposed key personnel.',
    ];
    clauses.forEach((c, i) => {
      doc.text(`${i + 1}.  ${c}`, { paragraphGap: 6 });
    });

    doc.moveDown();
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#666');
    doc.text(`Generated by Halford AI QS Workbench at ${new Date().toISOString()}`);

    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

module.exports = { generate };
