'use strict';
// AQUIQ service report (FSR): what the engineer fills in at the end of a job.
//
// Rules:
//  - Only the engineer assigned to the job can file it, and only once.
//  - It unlocks when the customer (or admin on their behalf) has approved. The engineer
//    may also go ahead without approval, but must give a reason; that is recorded on the
//    report and in the ticket history.
//  - Filing the report closes the ticket. The PDF is stored and emailed (when mail is set up).
//  - Device readings (TDS, flow, pump, membrane) come from the unit. The engineer cannot type
//    them; if a reading is missing it shows as "Not available" and is never guessed.

const express = require('express');
const { istParts, snapshotOf, mediaOf, PHOTO_BUCKET, ONLINE_WINDOW_MS } = require('./tickets');

const REPORT_BUCKET = 'service-reports';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NA = 'Not available';

// The same choices as the PR TECHNO FSR form.
const OPTIONS = {
  overall_status: ['Working', 'Under Maintenance', 'Completed', 'Pending', 'Critical'],
  capacity: ['100/150 LPH', '200/250 LPH', '400/500 LPH', '1000 LPH', '2000 LPH', '5000 LPH', '10000 LPH'],
  tds_status: ['NO ISSUE (USER)', 'ISSUE FOUND', 'NEEDS MONITORING'],
  load: ['No Fluctuation', 'Fluctuation'],
};
const REQUIRED = ['overall_status', 'capacity', 'tds_status', 'load'];

// Why the engineer is filing without the customer's approval.
const OVERRIDE_REASONS = [
  { key: 'customer_slow', en: 'Customer is taking time', hi: 'ग्राहक देर कर रहा है' },
  { key: 'next_complaint', en: 'I have to reach my next complaint', hi: 'मुझे अगली शिकायत पर जाना है' },
  { key: 'customer_disagrees', en: 'Work is complete, but the customer does not agree and it is not our fault',
    hi: 'काम पूरा है, ग्राहक सहमत नहीं है और इसमें हमारी गलती नहीं है' },
  { key: 'unreachable', en: 'Customer is not available / not reachable', hi: 'ग्राहक उपलब्ध नहीं है' },
  { key: 'refused', en: 'Customer refused to sign or approve', hi: 'ग्राहक ने मंज़ूरी देने से मना किया' },
  { key: 'other', en: 'Other (write the reason)', hi: 'अन्य (कारण लिखें)' },
];

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function clean(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max); }

const reportNo = (ticket) => `FSR-${ticket.ticket_no}`;

function serviceName(ticket) {
  const cat = ticket.issue_category;
  if (cat && cat !== 'Other') return `${cat} – RESOLVED`;
  const d = clean(ticket.description, 70);
  if (d) return `${d} – RESOLVED`;
  return `ISSUE - ${ticket.ticket_no} RESOLVED - AQUIQ`;
}

function pumpCondition(status) {
  switch (String(status || '').toLowerCase()) {
    case 'healthy': return 'Working condition';
    case 'overload': return 'Overload – needs attention';
    case 'weak': return 'Running weak – needs attention';
    case 'off': return 'Pump off';
    case 'calibrating': return 'Calibrating';
    default: return NA;
  }
}

// The six unit readings shown (read-only) on the report.
function deviceReadings(customer, at) {
  const s = snapshotOf(customer || {}, at);
  const val = (v, unit) => (v == null || v === '' || Number.isNaN(Number(v)) ? NA : `${Number(v)}${unit}`);
  return {
    captured_at: at.toISOString(),
    last_seen: s.last_seen,
    device_online: s.device_online,
    stale: !s.device_online,
    feed_tds: val(s.feed_tds, ' ppm'),
    output_tds: val(s.output_tds, ' ppm'),
    output_flow: val(s.output_flow, ' L/min'),
    reject_flow: val(s.reject_flow, ' L/min'),
    pump_condition: pumpCondition(s.pump_status),
    membrane: val(s.membrane_health, '%'),
  };
}

function istStamp(at) {
  const d = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(at);
  return d;
}

// ── PDF ──────────────────────────────────────────────────────────────────────

const INK = '#111111';
const MUTED = '#555555';
const AMBER = '#C25A00';

function renderPdf(report, images) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Service Report ${report.report_no}`, Author: 'PR TECHNO / AQUIQ' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width - 80;

    doc.fillColor(AMBER).font('Helvetica-Bold').fontSize(20).text('PR TECHNO  WMS', 40, 40);
    doc.fillColor(INK).fontSize(26).text('SERVICE REPORT', 40, 66);
    doc.fillColor(MUTED).font('Helvetica').fontSize(10)
      .text(`FSR No: ${report.report_no}`, 40, 44, { width: W, align: 'right' })
      .text(`Ticket: ${report.ticket_no}`, 40, 58, { width: W, align: 'right' })
      .text(`Date / time: ${report.when_label}`, 40, 72, { width: W, align: 'right' });
    doc.moveTo(40, 104).lineTo(40 + W, 104).strokeColor('#BBBBBB').stroke();

    let y = 116;
    const line = (label, value) => {
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(label.toUpperCase(), 40, y, { width: 130 });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(String(value || '—'), 175, y - 1, { width: W - 135 });
      y = Math.max(doc.y, y + 16) + 5;
    };
    line('Service name', report.service_name);
    line('Overall status', report.data.overall_status);
    line('Location', report.location);
    line('Admin (Mr./Ms.)', report.admin_name);
    y += 6;

    doc.fillColor(INK).font('Helvetica').fontSize(10.5).text(
      `Reverse Osmosis filters only in ${report.site_place || '—'}. His/her plant with stand is set up, and this service report covers all we have done; there are no outstanding tasks on our end, and our services and supplies have satisfied the user/client.`
      + (report.approval_mode === 'engineer_override'
        ? ` Note: this report was filed without the customer's approval (${report.override_reason}).`
        : ' The user testing has ended and is satisfactory.'),
      40, y, { width: W, align: 'justify' });
    y = doc.y + 14;

    const d = report.data;
    const dr = report.device_readings || {};
    const rows = [
      ['Color', 'Standard'], ['Make', 'SER_PRTEC'], ['Capacity', d.capacity],
      ['T.D.S Input (device)', dr.feed_tds], ['T.D.S Output (device)', `${dr.output_tds}   –   ${d.tds_status}`],
      ['Output flow (device)', dr.output_flow], ['Reject flow (device)', dr.reject_flow],
      ['Membrane (device)', dr.membrane], ['Pump (device)', dr.pump_condition],
      ['Load', d.load],
    ];
    if (d.remarks) rows.push(['Remarks / Notes', d.remarks]);   // only when the engineer wrote something
    rows.forEach(([k, v], i) => {
      if (y > 740) { doc.addPage(); y = 40; }
      const h = Math.max(22, doc.heightOfString(String(v || '—'), { width: W - 190, fontSize: 10.5 }) + 10);
      if (i % 2 === 0) doc.rect(40, y, W, h).fillColor('#F4F4F4').fill();
      doc.fillColor(MUTED).font('Helvetica').fontSize(10).text(k, 48, y + 6, { width: 160 });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text(String(v || '—'), 215, y + 6, { width: W - 190 });
      y += h;
    });
    if (dr.captured_at) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(
        `Device readings captured ${istStamp(new Date(dr.captured_at))}${dr.stale ? ' – the unit was offline at that time, so values may be old or unavailable' : ''}. AQUIQ test.`,
        40, y + 6, { width: W });
      y = doc.y + 10;
    }

    // photos
    if (images.length) {
      doc.addPage();
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text('Site photos', 40, 40);
      let px = 40; let py = 66; const cell = (W - 20) / 3;
      for (const im of images) {
        if (py + cell + 16 > 790) { doc.addPage(); py = 40; px = 40; }
        try { doc.image(im.buffer, px, py, { fit: [cell, cell], align: 'center', valign: 'center' }); } catch { /* skip unreadable */ }
        doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(im.kind, px, py + cell + 2, { width: cell });
        px += cell + 10;
        if (px > 40 + W - cell) { px = 40; py += cell + 22; }
      }
    }
    if (report.videos && report.videos.length) {
      doc.addPage();
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text('Videos', 40, 40);
      doc.fillColor(MUTED).font('Helvetica').fontSize(10)
        .text('Videos are stored securely by AQUIQ and can be shown on request.', 40, 64, { width: W });
      doc.fillColor(INK).fontSize(11);
      report.videos.forEach((v, i) => doc.text(`${i + 1}. ${v.kind} video – ${v.when}`, 40, doc.y + 6));
    }

    // signature block
    doc.addPage();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text('Service engineer', 40, 60);
    doc.font('Helvetica').fontSize(11)
      .text(report.engineer_designation ? `${report.engineer_name}, ${report.engineer_designation}` : report.engineer_name, 40, doc.y + 8)
      .text(`ID: ${report.engineer_code}`)
      .text(`Report filed: ${report.when_label} (India time)`);
    doc.moveDown(2).font('Helvetica-Bold').text('Customer approval', 40, doc.y);
    doc.font('Helvetica').text(report.approval_label, 40, doc.y + 6, { width: W });
    doc.fillColor(MUTED).fontSize(9).text('PR TECHNO  |  AQUIQ Water Monitoring', 40, 780, { width: W, align: 'center' });
    doc.end();
  });
}

// ── mail (nodemailer) ───────────────────────────────────────────────────────

function createMailer(env = process.env) {
  const user = env.MAIL_USER; const pass = env.MAIL_PASS;
  const enabled = !!(user && pass);
  let transport = null;
  return {
    enabled,
    copyTo: env.REPORT_COPY_TO || 'careprtech@hotmail.com',
    async send({ to, cc, subject, text, attachments }) {
      if (!enabled) throw httpError(503, 'Mail is not set up.');
      if (!transport) {
        const nodemailer = require('nodemailer');
        transport = nodemailer.createTransport({
          host: env.MAIL_HOST || 'smtp.gmail.com', port: Number(env.MAIL_PORT) || 465, secure: (Number(env.MAIL_PORT) || 465) === 465,
          auth: { user, pass },
        });
      }
      await transport.sendMail({
        from: `"${env.MAIL_FROM_NAME || 'AQUIQ Service Desk'}" <${env.MAIL_FROM || user}>`,
        to, cc, subject, text, attachments,
      });
    },
  };
}

// ── service ──────────────────────────────────────────────────────────────────

function createReportService(store, tickets, { now = () => new Date(), mailer, fetchBytes } = {}) {
  const mail = mailer || { enabled: false, copyTo: null, send: async () => { throw httpError(503, 'Mail is not set up.'); } };

  async function mine(eng, id) {
    if (!UUID_RE.test(String(id))) throw httpError(400, 'Invalid job.');
    const t = await store.getTicket(id);
    if (!t || t.engineer_id !== eng.id) throw httpError(404, 'This job is not assigned to you.');
    return t;
  }

  function header(t, at) {
    return {
      report_no: reportNo(t), ticket_no: t.ticket_no, service_name: serviceName(t),
      when_label: istStamp(at), location: [t.address, t.pincode].filter(Boolean).join(' – ') || null,
      admin_name: t.contact_person || null, site_place: t.site_name || t.address || null,
      latitude: t.latitude ?? null, longitude: t.longitude ?? null,
    };
  }

  // What the report screen shows before the engineer starts typing.
  async function form(eng, id) {
    const t = await mine(eng, id);
    const at = now();
    const existing = await store.getReportByTicket(t.id);
    const customer = await store.getCustomer(t.customer_id);
    const state = existing ? 'filed'
      : t.status === 'approved' ? 'ready'
      : t.status === 'work_done' ? 'needs_reason'
      : 'locked';
    return {
      state, ...header(t, at),
      device: deviceReadings(customer, at),
      options: OPTIONS, required: REQUIRED, reasons: OVERRIDE_REASONS,
      filed: existing ? { report_no: existing.report_no, created_at: existing.created_at } : null,
    };
  }

  function validate(input) {
    const d = {};
    for (const k of Object.keys(OPTIONS)) {
      const v = clean(input[k], 60);
      if (v && !OPTIONS[k].includes(v)) throw httpError(400, `"${v}" is not a valid choice for ${k.replace('_', ' ')}.`);
      d[k] = v || null;
    }
    const missing = REQUIRED.filter(k => !d[k]);
    if (missing.length) throw httpError(400, `Please fill in: ${missing.map(m => m.replace(/_/g, ' ')).join(', ')}.`);
    d.remarks = clean(input.remarks, 1500) || null;
    return d;
  }

  async function loadImages(ticketId) {
    const media = await store.listPhotos(ticketId);
    const photos = media.filter(m => mediaOf(m) === 'photo');
    const videos = media.filter(m => mediaOf(m) === 'video');
    const images = [];
    if (fetchBytes) {
      for (const p of photos.slice(0, 18)) {
        try {
          const url = await store.signedReadUrl(PHOTO_BUCKET, p.path, 300);
          images.push({ kind: p.kind === 'other' ? 'during / other' : p.kind, buffer: await fetchBytes(url) });
        } catch { /* a photo that can't be fetched is left out of the PDF; it stays on the job */ }
      }
    }
    return {
      images, photoCount: photos.length,
      videos: videos.map(v => ({ kind: v.kind === 'other' ? 'during / other' : v.kind, when: istStamp(new Date(v.created_at)) })),
    };
  }

  async function submit(eng, id, input) {
    const t = await mine(eng, id);
    if (await store.getReportByTicket(t.id)) throw httpError(409, 'The service report for this job has already been filed.');
    if (!['approved', 'work_done'].includes(t.status)) {
      throw httpError(409, 'The report opens after you mark the work done.');
    }

    // approval: customer / admin already approved, or the engineer goes ahead with a reason
    let approvalMode = t.customer_response === 'approved_by_admin' ? 'admin' : 'customer';
    let overrideReason = null;
    if (t.status === 'work_done') {
      const key = clean(input.override_reason, 40);
      const r = OVERRIDE_REASONS.find(x => x.key === key);
      if (!r) throw httpError(400, 'Choose why you are filing without the customer’s approval.');
      overrideReason = r.key === 'other' ? clean(input.override_note, 300) : r.en;
      if (r.key === 'other' && overrideReason.length < 3) throw httpError(400, 'Write the reason.');
      approvalMode = 'engineer_override';
    }

    const data = validate(input);
    const at = now();
    const customer = await store.getCustomer(t.customer_id);
    const readings = deviceReadings(customer, at);
    const head = header(t, at);
    const approvalLabel = approvalMode === 'customer' ? 'Approved by the customer in the AQUIQ app.'
      : approvalMode === 'admin' ? 'Approved on the customer’s behalf by AQUIQ.'
      : `Filed WITHOUT customer approval. Reason: ${overrideReason}`;

    const media = await loadImages(t.id);
    const full = {
      ...head, data, device_readings: readings, approval_mode: approvalMode, override_reason: overrideReason,
      approval_label: approvalLabel, engineer_name: eng.name, engineer_code: eng.engineer_code,
      engineer_designation: eng.designation || null, videos: media.videos,
    };
    const pdf = await renderPdf(full, media.images);
    const pdfPath = `${t.id}/${head.report_no}.pdf`;
    await store.uploadObject(REPORT_BUCKET, pdfPath, pdf, 'application/pdf');

    // Save the report first (one per ticket is enforced by the database), then move the ticket.
    let row;
    try {
      row = await store.insertReport({
        ticket_id: t.id, report_no: head.report_no, engineer_id: eng.id, service_name: head.service_name,
        data: { ...data, engineer_name: eng.name, engineer_code: eng.engineer_code, engineer_designation: eng.designation || null },
        device_readings: readings, approval_mode: approvalMode, override_reason: overrideReason, pdf_path: pdfPath,
        created_at: at.toISOString(),
      });
    } catch (err) {
      if (err.status === 409) throw httpError(409, 'The service report for this job has already been filed.');
      throw err;
    }

    const actor = { email: `${eng.name} (${eng.engineer_code})`, role: 'engineer' };
    try {
      if (approvalMode === 'engineer_override') {
        await tickets.act(t.id, { action: 'engineer_override', note: `Filed without customer approval: ${overrideReason}` }, actor);
      }
      await tickets.act(t.id, { action: 'close', note: `Service report ${head.report_no} filed` }, actor);
    } catch (err) {
      await store.deleteReport(row.id).catch(() => {});
      throw err;
    }
    await store.insertEvent({
      ticket_id: t.id, actor: actor.email, actor_role: 'engineer', action: 'report_filed',
      from_status: 'closed', to_status: 'closed', note: head.report_no,
      meta: { approval_mode: approvalMode, override_reason: overrideReason, photos: media.photoCount, videos: media.videos.length },
    });

    const emailed = await sendEmail(row, t, pdf, full);
    return { report_no: head.report_no, approval_mode: approvalMode, email_status: emailed.email_status };
  }

  async function sendEmail(row, t, pdf, full) {
    const to = [];
    const custEmail = await store.getCustomerEmail(t.customer_id).catch(() => null);
    if (custEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(custEmail)) to.push(custEmail.toLowerCase());
    const copy = mail.copyTo;
    let status; let error = null;
    if (!mail.enabled) status = 'disabled';
    else if (!to.length && !copy) status = 'no_customer_email';
    else {
      try {
        await mail.send({
          to: to.length ? to : copy, cc: to.length && copy ? copy : undefined,
          subject: `Service report ${row.report_no} – AQUIQ`,
          text: `Dear ${t.contact_person || 'Customer'},\n\nYour RO service is complete. The service report ${row.report_no} for ticket ${t.ticket_no} is attached.\n\nService: ${row.service_name}\nSite: ${t.site_name || ''}\nEngineer: ${full.engineer_name}\n\nThank you,\nAQUIQ Service Desk\nPR TECHNO`,
          attachments: [{ filename: `${row.report_no}.pdf`, content: pdf, contentType: 'application/pdf' }],
        });
        status = to.length ? 'sent' : 'no_customer_email';
      } catch (err) { status = 'failed'; error = clean(err.message, 300); }
    }
    const patch = { email_status: status, email_to: to.length ? to : null, email_error: error, emailed_at: status === 'sent' ? now().toISOString() : null };
    await store.updateReport(row.id, patch).catch(() => {});
    return patch;
  }

  // admin: see the report, get a download link, re-send the email
  async function adminView(ticketId) {
    if (!UUID_RE.test(String(ticketId))) throw httpError(400, 'Invalid ticket.');
    const r = await store.getReportByTicket(ticketId);
    if (!r) return { report: null };
    const t = await store.getTicket(ticketId);
    return {
      report: {
        report_no: r.report_no, service_name: r.service_name, created_at: r.created_at,
        approval_mode: r.approval_mode, override_reason: r.override_reason,
        email_status: r.email_status, email_to: r.email_to, email_error: r.email_error,
        data: r.data, device_readings: r.device_readings,
        pdf_url: r.pdf_path ? await store.signedReadUrl(REPORT_BUCKET, r.pdf_path, 600) : null,
        ticket_no: t && t.ticket_no,
      },
    };
  }

  async function adminResend(ticketId) {
    const r = await store.getReportByTicket(ticketId);
    if (!r) throw httpError(404, 'No service report for this ticket yet.');
    if (!mail.enabled) throw httpError(503, 'Email is not set up yet.');
    const t = await store.getTicket(ticketId);
    const url = await store.signedReadUrl(REPORT_BUCKET, r.pdf_path, 120);
    const pdf = await fetchBytes(url);
    const out = await sendEmail(r, t, pdf, { engineer_name: '' });
    return { email_status: out.email_status, email_error: out.email_error };
  }

  return { form, submit, adminView, adminResend, OPTIONS, OVERRIDE_REASONS };
}

// ── Supabase-backed store ────────────────────────────────────────────────────

function supabaseReportStore(sb) {
  const one = async (q) => {
    const { data, error } = await q;
    if (error) {
      const e = httpError(error.code === '23505' ? 409 : (error.code === '42P01' || error.code === 'PGRST205') ? 503 : 500,
        error.code === '23505' ? 'Already filed.' : (error.code === '42P01' || error.code === 'PGRST205') ? 'Service reports are not set up yet. Run the SQL migration in Supabase first.' : 'Database error.');
      e.detail = error.message;
      throw e;
    }
    return data;
  };
  return {
    getReportByTicket: (ticketId) => one(sb.from('service_reports').select('*').eq('ticket_id', ticketId).maybeSingle()),
    insertReport: (row) => one(sb.from('service_reports').insert([row]).select().single()),
    updateReport: (id, patch) => one(sb.from('service_reports').update(patch).eq('id', id)),
    deleteReport: (id) => one(sb.from('service_reports').delete().eq('id', id)),
    async uploadObject(bucket, path, buffer, contentType) {
      const { error } = await sb.storage.from(bucket).upload(path, buffer, { contentType, upsert: true });
      if (error) { const e = httpError(500, 'Could not store the report file.'); e.detail = error.message; throw e; }
    },
    // The customer's login email lives on the uhads (account) row that owns the store.
    async getCustomerEmail(customerId) {
      const c = await one(sb.from('customers').select('uhad_id').eq('id', customerId).maybeSingle());
      if (!c || !c.uhad_id) return null;
      const u = await one(sb.from('uhads').select('email').eq('id', c.uhad_id).maybeSingle());
      return u && u.email ? u.email : null;
    },
  };
}

function createReportsAdminRouter(service) {
  const router = express.Router();
  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (err) {
      if (!err.status || err.status >= 500) console.error('[REPORTS]', err.message, err.detail || '');
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong.' });
    }
  };
  router.get('/:ticketId', wrap((req) => service.adminView(req.params.ticketId)));
  router.post('/:ticketId/resend', wrap((req) => service.adminResend(req.params.ticketId)));
  return router;
}

module.exports = {
  OPTIONS, REQUIRED, OVERRIDE_REASONS, REPORT_BUCKET,
  serviceName, reportNo, pumpCondition, deviceReadings, renderPdf, createMailer,
  createReportService, supabaseReportStore, createReportsAdminRouter,
};
