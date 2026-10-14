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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PER_DAY = 5;
const DAY_MS = 24 * 3600 * 1000;

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(-10);
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);

function createCustomerService(store, tickets, { now = () => new Date() } = {}) {
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

  function view(t) {
    return {
      id: t.id, ticket_no: t.ticket_no, status: t.status, status_label: STATUS_LABELS[t.status] || t.status,
      issue_category: t.issue_category, description: t.description, created_at: t.created_at,
      engineer_name: ['accepted', 'arrived', 'work_done', 'approved', 'reopened'].includes(t.status) ? t.engineer_name : null,
      eta_at: t.status === 'accepted' ? t.eta_at : null,
      active: !TERMINAL.includes(t.status),
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
    return { tickets: (await store.listByCustomer(c.id, 10)).map(view), categories: CATEGORIES };
  }

  return { request, list };
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
  return router;
}

module.exports = { createCustomerService, createCustomerRouter };
