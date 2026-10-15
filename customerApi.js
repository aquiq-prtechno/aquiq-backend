'use strict';
// Customer-facing service requests (the AQUIQ customer app).
//
// A store owner taps "Request service" -> a ticket is created -> every registered engineer
// who covers that site sees it as a new complaint in the AQUIQ SE-TECH app.
//
// Who is asking: the customer app sends the store id and the store's registered mobile number
// (the same proof the app's own store login uses). It is a light check, so the damage a wrong
// guess can do is limited on purpose:
//   - one open request per store at a time (a second tap returns the open one);
//   - at most 5 new requests per store per day;
//   - the reply never contains personal data, only the ticket number and its progress.

const express = require('express');
const { CATEGORIES, STATUS_LABELS, TERMINAL } = require('./tickets');
const REPORT_BUCKET = 'service-reports';
const fileLinks = require('./fileLinks');
const visitLog = require('./visitLog');
const { createAskService } = require('./askBrain');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PER_DAY = 5;
const DAY_MS = 24 * 3600 * 1000;

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(-10);
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);

const toRad = (d) => (d * Math.PI) / 180;
function km(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat); const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const LOCATION_FRESH_MS = 10 * 60 * 1000;
const ROAD_FACTOR = 1.4;       // straight line -> typical road distance
const AVG_KMH = 28;            // average city speed for a two-wheeler

function createCustomerService(store, tickets, { now = () => new Date(), reports = null, ask = null } = {}) {
  const brain = ask || createAskService({ now });
  async function who(input) {
    const id = String(input.store_id || '');
    const phone = digits(input.phone);
    const c = UUID_RE.test(id) ? await store.getCustomer(id) : null;
    // one message for every failure, so nobody can probe which stores exist
    if (!c || phone.length !== 10 || digits(c.phone) !== phone) {
      throw httpError(401, 'We could not verify this store. Please log in again.');
    }
    return c;
  }

  // Where the engineer is and roughly how long they need — only while they are on the way.
  function trackOf(t) {
    if (t.status !== 'accepted' || t.eng_lat == null || t.eng_lng == null || !t.eng_loc_at) return null;
    if (now().getTime() - new Date(t.eng_loc_at).getTime() > LOCATION_FRESH_MS) return null;
    const out = { lat: Number(t.eng_lat), lng: Number(t.eng_lng), updated_at: t.eng_loc_at };
    if (t.latitude != null && t.longitude != null) {
      out.site = { lat: Number(t.latitude), lng: Number(t.longitude) };   // the customer's own site
      const straight = km({ lat: out.lat, lng: out.lng }, { lat: Number(t.latitude), lng: Number(t.longitude) });
      out.distance_km = Math.round(straight * ROAD_FACTOR * 10) / 10;
      out.eta_minutes = Math.max(1, Math.round((out.distance_km / AVG_KMH) * 60));
    }
    return out;
  }

  function view(t) {
    return {
      id: t.id, ticket_no: t.ticket_no, status: t.status, status_label: STATUS_LABELS[t.status] || t.status,
      issue_category: t.issue_category, description: t.description, created_at: t.created_at,
      engineer_name: ['accepted', 'arrived', 'work_done', 'approved', 'reopened', 'closed'].includes(t.status) ? t.engineer_name : null,
      closed_at: t.closed_at || null,
      eta_at: t.status === 'accepted' ? t.eta_at : null,
      active: !TERMINAL.includes(t.status),
      can_respond: t.status === 'work_done',          // the customer may approve or say not satisfied
      engineer_location: trackOf(t),
    };
  }

  async function request(input) {
    const c = await who(input);
    const recent = await store.listByCustomer(c.id, 20);

    const open = recent.find(t => !TERMINAL.includes(t.status));
    if (open) return { ticket: view(open), already_open: true };

    const since = now().getTime() - DAY_MS;
    if (recent.filter(t => new Date(t.created_at).getTime() >= since).length >= MAX_PER_DAY) {
      throw httpError(429, 'You have reached today’s limit for service requests. Please call PR TECHNO support.');
    }

    const category = clean(input.issue_category, 80) || 'Other';
    if (!CATEGORIES.includes(category)) throw httpError(400, 'Choose what the problem is.');
    const description = clean(input.description, 1000);
    if (description.length < 3) throw httpError(400, 'Please describe the problem in a few words.');

    const created = await tickets.create({
      customer_id: c.id, issue_category: category, description,
      urgency: input.urgency === 'urgent' ? 'urgent' : 'normal',
      contact_person: clean(input.contact_person, 120) || undefined,
      contact_phone: digits(input.contact_phone).length === 10 ? digits(input.contact_phone) : undefined,
    }, { email: `customer: ${c.name || c.id}`, role: 'customer' }, { source: 'customer_app' });
    return { ticket: view(created), already_open: false };
  }

  async function list(input) {
    const c = await who(input);
    const rows = await store.listByCustomer(c.id, 30);
    const out = [];
    for (const t of rows) {
      const v = view(t);
      if (t.status === 'closed' && store.getReportByTicket) {
        const r = await store.getReportByTicket(t.id).catch(() => null);
        v.report_available = !!(r && (r.pdf_path || r.pdf_purged_at || r.media_purged_at || r.report_no));
        v.rating = r && r.rating != null ? r.rating : null;
        v.report_no = r ? r.report_no : null;
      }
      out.push(v);
    }
    return { tickets: out, categories: CATEGORIES };
  }

  // the customer's own ticket, or an error that reveals nothing about other tickets
  async function ownTicket(c, ticketId) {
    const t = UUID_RE.test(String(ticketId)) ? await store.getTicket(ticketId) : null;
    if (!t || t.customer_id !== c.id) throw httpError(404, 'We could not find that request.');
    return t;
  }

  async function approve(input) {
    const c = await who(input);
    const t = await ownTicket(c, input.ticket_id);
    if (t.status !== 'work_done') throw httpError(409, 'This request is not waiting for your approval.');
    const out = await tickets.act(t.id, { action: 'approve' }, { email: `customer: ${c.name || c.id}`, role: 'customer' });
    return { ticket: view(out) };
  }

  async function notSatisfied(input) {
    const c = await who(input);
    const t = await ownTicket(c, input.ticket_id);
    if (t.status !== 'work_done') throw httpError(409, 'This request is not waiting for your approval.');
    const reason = clean(input.reason, 500);
    if (reason.length < 3) throw httpError(400, 'Please tell us what is still wrong.');
    const out = await tickets.act(t.id, { action: 'not_satisfied', note: reason }, { email: `customer: ${c.name || c.id}`, role: 'customer' });
    return { ticket: view(out) };
  }

  async function rate(input) {
    const c = await who(input);
    const t = await ownTicket(c, input.ticket_id);
    const n = Number(input.rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw httpError(400, 'Please choose a rating from 1 to 5.');
    if (t.status !== 'closed') throw httpError(409, 'You can rate a service once it is finished.');
    const r = await store.getReportByTicket(t.id);
    if (!r) throw httpError(404, 'The service report is not ready yet.');
    if (r.rating != null) throw httpError(409, 'You have already rated this service. Thank you!');
    await store.updateReport(r.id, { rating: n, rating_comment: clean(input.comment, 500) || null, rated_at: now().toISOString() });
    return { ok: true, rating: n };
  }

  async function report(input) {
    const c = await who(input);
    const t = await ownTicket(c, input.ticket_id);
    if (reports) {
      const l = await reports.linkFor(t.id);
      if (!l) throw httpError(404, 'The service report is not ready yet.');
      return { report_no: l.report_no, pdf_url: l.pdf_url };
    }
    const r = await store.getReportByTicket(t.id);
    if (!r || !r.pdf_path) throw httpError(404, 'The service report is not ready yet.');
    return { report_no: r.report_no, pdf_url: await store.signedReadUrl(REPORT_BUCKET, r.pdf_path, 600) };
  }

  // every finished AQUIQ service and every visit the customer logged, one line each
  async function visitRows(c) {
    const tix = await store.listByCustomer(c.id, 1000);
    const manual = store.listServiceHistory ? await store.listServiceHistory(c.device_id || c.id).catch(() => []) : [];
    return visitLog.rowsFrom(tix, manual);
  }

  async function visits(input) {
    const c = await who(input);
    const rows = await visitRows(c);
    return { visits: rows.map(r => ({ ...r, has_report: r.kind === 'aquiq' })) };
  }

  // a short-lived link; the file is built fresh when it is opened
  async function exportLink(input) {
    const c = await who(input);
    const fmt = input.format === 'pdf' ? 'pdf' : 'xlsx';
    const token = fileLinks.sign({ k: 'visitlog', cid: c.id, fmt }, 600);
    return { url: `${fileLinks.baseUrl()}/files/visit-log/${token}`, format: fmt };
  }

  async function buildExport(customerId, fmt) {
    const c = await store.getCustomer(customerId);
    if (!c) throw httpError(404, 'Store not found.');
    const rows = await visitRows(c);
    const args = { storeName: c.name, rows, generatedAt: now() };
    return fmt === 'pdf'
      ? { buffer: await visitLog.buildPdf(args), type: 'application/pdf', name: 'AQUIQ-visit-log.pdf' }
      : { buffer: await visitLog.buildXlsx(args), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'AQUIQ-visit-log.xlsx' };
  }

  // Ask AQUIQ: questions about the service system, the visit log and the open request
  async function askQuestion(input) {
    const c = await who(input);
    const question = clean(input.question, 600);
    if (question.length < 2) throw httpError(400, 'Please type your question.');
    const rows = await visitRows(c);
    const recent = await store.listByCustomer(c.id, 5);
    const open = recent.find(t => !TERMINAL.includes(t.status));
    const active = open ? view(open) : null;
    const out = await brain.answer({ storeId: c.id, question, history: input.history, store: c, rows, active });
    return { answer: out.answer, mode: out.mode };
  }

  return { request, list, approve, notSatisfied, report, rate, visits, exportLink, buildExport, ask: askQuestion };
}

function createCustomerRouter(service) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (err) {
      if (!err.status || err.status >= 500) console.error('[CUSTOMER]', err.message, err.detail || '');
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong. Please try again.' });
    }
  };
  router.post('/service-request', wrap((req) => service.request(req.body || {})));
  router.post('/service-requests', wrap((req) => service.list(req.body || {})));
  router.post('/service-request/approve', wrap((req) => service.approve(req.body || {})));
  router.post('/service-request/not-satisfied', wrap((req) => service.notSatisfied(req.body || {})));
  router.post('/service-request/report', wrap((req) => service.report(req.body || {})));
  router.post('/service-request/rate', wrap((req) => service.rate(req.body || {})));
  router.post('/ask', wrap((req) => service.ask(req.body || {})));
  router.post('/visit-log', wrap((req) => service.visits(req.body || {})));
  router.post('/visit-log/export', wrap((req) => service.exportLink(req.body || {})));
  return router;
}

// Public, token-protected downloads for files that are built on request.
function createFilesRouter({ customerService, reportService }) {
  const router = express.Router();
  const fail = (res, status, msg) => res.status(status).type('text/plain').send(msg);
  router.get('/report/:token', async (req, res) => {
    const p = fileLinks.verify(req.params.token);
    if (!p || p.k !== 'report') return fail(res, 410, 'This link has expired. Please open the report again from the app.');
    try {
      const pdf = await reportService.renderStored(p.tid);
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="AQUIQ-service-report.pdf"', 'Cache-Control': 'no-store' });
      res.send(pdf);
    } catch (e) { console.error('[FILES] report', e.message); fail(res, e.status || 500, 'The report could not be prepared.'); }
  });
  router.get('/visit-log/:token', async (req, res) => {
    const p = fileLinks.verify(req.params.token);
    if (!p || p.k !== 'visitlog') return fail(res, 410, 'This link has expired. Please download again from the app.');
    try {
      const f = await customerService.buildExport(p.cid, p.fmt);
      res.set({ 'Content-Type': f.type, 'Content-Disposition': `attachment; filename="${f.name}"`, 'Cache-Control': 'no-store' });
      res.send(f.buffer);
    } catch (e) { console.error('[FILES] visit log', e.message); fail(res, e.status || 500, 'The file could not be prepared.'); }
  });
  return router;
}

module.exports = { createCustomerService, createCustomerRouter, createFilesRouter };
