'use strict';
// The AQUIQ logo and letterhead that appear on every report and every export.
const fs = require('fs');
const path = require('path');

const LOGO_PATH = path.join(__dirname, 'assets', 'aquiq-logo.png');
const LETTERHEAD = {
  company: 'PR TECHNO Enterprises',
  product: 'AQUIQ™ Water Monitoring Systems',
  line: 'info@prtechno.in  ·  careprtech@hotmail.com',
};

let logoBuf = null;
function logo() {
  if (logoBuf === null) {
    try { logoBuf = fs.readFileSync(LOGO_PATH); } catch { logoBuf = false; }
  }
  return logoBuf || null;
}

// Footer printed at the bottom of every page of a pdfkit document (call after all pages exist).
function stampFooters(doc, stampText, leftText) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const { width, height } = doc.page;
    doc.page.margins.bottom = 0;                        // lets us write inside the bottom margin
    const w = width - 80;
    doc.moveTo(40, height - 52).lineTo(40 + w, height - 52).strokeColor('#CCCCCC').lineWidth(0.5).stroke();
    doc.fillColor('#333333').font('Helvetica-Bold').fontSize(8.5)
      .text(`${LETTERHEAD.company}  |  ${LETTERHEAD.product}`, 40, height - 46, { width: w, align: 'center', lineBreak: false });
    doc.fillColor('#666666').font('Helvetica').fontSize(8)
      .text(LETTERHEAD.line, 40, height - 34, { width: w, align: 'center', lineBreak: false });
    if (leftText) {
      doc.fillColor('#111111').fontSize(8.5)
        .text(leftText, 40, 16, { width: w / 2, lineBreak: false })
        .text(stampText || '', 40 + w / 2, 16, { width: w / 2, align: 'right', lineBreak: false });
    }
  }
}

module.exports = { LETTERHEAD, logo, stampFooters };
