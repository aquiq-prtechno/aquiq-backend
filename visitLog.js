'use strict';
// The customer's visit log: every AQUIQ service (with its report) and every visit they logged
// themselves, one line each, newest first. Exports are built fresh each time they are asked for,
// so the Excel / PDF always contains the latest visits.

const { logo, LETTERHEAD, stampFooters } = require('./letterhead');

const IST = { timeZone: 'Asia/Kolkata' };
const dateOf = (iso) => new Intl.DateTimeFormat('en-GB', { ...IST, day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso));
const timeOf = (iso) => new Intl.DateTimeFormat('en-GB', { ...IST, hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(iso));

const WORK_LABELS = {
  filter_membrane: 'Raw water issue / Filter or Membrane change',
  pump_repair: 'Pump repair',
  routine_service: 'General routine service',
  other: 'Other',
};

function rowsFrom(tickets, manual) {
  const rows = [];
  for (const t of tickets) {
    if (t.status !== 'closed') continue;
    rows.push({
      kind: 'aquiq', at: t.closed_at || t.work_done_at || t.created_at, ticket_id: t.id, ticket_no: t.ticket_no,
      report_no: `FSR-${t.ticket_no}`, engineer: t.engineer_name || '', phone: '',
      issue: t.issue_category || '', notes: t.description || '',
    });
  }
  for (const v of manual) {
    rows.push({
      kind: 'manual', at: v.visit_date, ticket_id: null, ticket_no: '', report_no: '',
      engineer: v.technician_name || '', phone: v.technician_phone || '',
      issue: WORK_LABELS[v.work_type] || v.work_type || '', notes: v.work_notes || '',
    });
  }
  rows.sort((a, b) => new Date(b.at) - new Date(a.at));
  return rows;
}

async function buildXlsx({ storeName, rows, generatedAt = new Date() }) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AQUIQ';
  const ws = wb.addWorksheet('Visit log', { views: [{ state: 'frozen', ySplit: 6 }] });
  ws.columns = [
    { key: 'no', width: 6 }, { key: 'date', width: 14 }, { key: 'time', width: 11 }, { key: 'type', width: 18 },
    { key: 'ticket', width: 22 }, { key: 'report', width: 26 }, { key: 'engineer', width: 22 },
    { key: 'phone', width: 14 }, { key: 'issue', width: 40 }, { key: 'notes', width: 46 },
  ];
  const lg = logo();
  if (lg) {
    const id = wb.addImage({ buffer: lg, extension: 'png' });
    ws.addImage(id, { tl: { col: 0, row: 0 }, ext: { width: 64, height: 64 } });
  }
  ws.mergeCells('C1:J1'); ws.getCell('C1').value = LETTERHEAD.company;
  ws.getCell('C1').font = { bold: true, size: 16 };
  ws.mergeCells('C2:J2'); ws.getCell('C2').value = `${LETTERHEAD.product}  ·  ${LETTERHEAD.line}`;
  ws.getCell('C2').font = { size: 10, color: { argb: 'FF555555' } };
  ws.mergeCells('C3:J3'); ws.getCell('C3').value = `Visit log — ${storeName || 'Store'}`;
  ws.getCell('C3').font = { bold: true, size: 13 };
  ws.mergeCells('C4:J4'); ws.getCell('C4').value = `Generated ${dateOf(generatedAt)} ${timeOf(generatedAt)} IST  ·  ${rows.length} visit(s)`;
  ws.getCell('C4').font = { size: 10, color: { argb: 'FF555555' } };
  ws.getRow(1).height = 24; ws.getRow(2).height = 18; ws.getRow(3).height = 20; ws.getRow(4).height = 18;

  const head = ws.getRow(6);
  ['No.', 'Date', 'Time (IST)', 'Type', 'Ticket no.', 'Report no.', 'Engineer', 'Engineer phone', 'Problem / work', 'Notes']
    .forEach((h, i) => {
      const c = head.getCell(i + 1);
      c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B1F3A' } };
      c.alignment = { vertical: 'middle' };
    });
  head.height = 22;
  rows.forEach((r, i) => {
    ws.addRow({
      no: i + 1, date: dateOf(r.at), time: timeOf(r.at),
      type: r.kind === 'aquiq' ? 'AQUIQ service' : 'Logged visit',
      ticket: r.ticket_no, report: r.report_no, engineer: r.engineer, phone: r.phone, issue: r.issue, notes: r.notes,
    });
  });
  ws.autoFilter = { from: 'A6', to: 'J6' };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function buildPdf({ storeName, rows, generatedAt = new Date() }) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40, bufferPages: true,
      info: { Title: `AQUIQ visit log – ${storeName || ''}`, Author: 'AQUIQ' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width - 80;
    const cols = [
      ['No.', 30], ['Date', 70], ['Time', 58], ['Type', 80], ['Ticket no.', 120], ['Engineer', 110], ['Problem / work', W - 468],
    ];
    const head = (first) => {
      let y = 40;
      if (first) {
        const lg = logo();
        if (lg) { try { doc.image(lg, 40, 34, { fit: [52, 52] }); } catch { /* optional */ } }
        doc.fillColor('#111').font('Helvetica-Bold').fontSize(18).text(LETTERHEAD.company, 104, 36);
        doc.fillColor('#555').font('Helvetica').fontSize(10).text(`${LETTERHEAD.product}  ·  ${LETTERHEAD.line}`, 104, 58);
        doc.fillColor('#111').font('Helvetica-Bold').fontSize(14).text(`Visit log — ${storeName || 'Store'}`, 104, 74);
        doc.fillColor('#555').font('Helvetica').fontSize(9)
          .text(`Generated ${dateOf(generatedAt)} ${timeOf(generatedAt)} IST · ${rows.length} visit(s)`, 40, 74, { width: W, align: 'right' });
        y = 104;
      }
      doc.rect(40, y, W, 20).fillColor('#0B1F3A').fill();
      let x = 40;
      cols.forEach(([t, w]) => { doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9).text(t, x + 5, y + 6, { width: w - 8, lineBreak: false }); x += w; });
      return y + 24;
    };
    let y = head(true);
    rows.forEach((r, i) => {
      const cells = [String(i + 1), dateOf(r.at), timeOf(r.at), r.kind === 'aquiq' ? 'AQUIQ service' : 'Logged visit',
        r.ticket_no || '—', r.engineer || '—', r.issue + (r.notes && r.kind === 'manual' ? ` — ${r.notes}` : '')];
      const h = Math.max(20, doc.heightOfString(cells[6], { width: cols[6][1] - 8, fontSize: 9 }) + 10);
      if (y + h > doc.page.height - 70) { doc.addPage(); y = head(false); }
      if (i % 2 === 0) doc.rect(40, y - 2, W, h).fillColor('#F3F5F8').fill();
      let x = 40;
      cells.forEach((c, k) => { doc.fillColor('#111').font('Helvetica').fontSize(9).text(c, x + 5, y + 3, { width: cols[k][1] - 8 }); x += cols[k][1]; });
      y += h;
    });
    if (!rows.length) doc.fillColor('#555').font('Helvetica').fontSize(11).text('No visits yet.', 40, y + 10);
    stampFooters(doc, '', '');
    doc.end();
  });
}

module.exports = { rowsFrom, buildXlsx, buildPdf, dateOf, timeOf };
