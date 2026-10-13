'use strict';
// AQUIQ service tickets — phase 1 (admin job board).
//
// Everything here runs on the server. The tickets tables are locked to the
// public key, so the admin panel reads and writes them only through these
// routes, which sit behind the admin login (mounted under /admin/tickets).
//
// Ticket number:  PMR + YY + 117 + counter + MMDD      e.g. PMR2611790001013
//   117 = A(1) Q(17).  The counter starts at 9000 and NEVER restarts: it runs on
//   across days and across years. Only YY (26 -> 27 on 1 January) and MMDD change.
//   YY and MMDD are taken in India time (IST) when the complaint is raised.

const express = require('express');
const { rankEngineers } = require('./engineers');

const SERIES = 'PMR';
const MIDDLE = '117';
const START_SEQ = 9000;

const ONLINE_WINDOW_MS = 10 * 60 * 1000;
const NO_ACCEPT_SECONDS = 60;            // unaccepted for 1 minute -> admin alert
const CUSTOMER_SILENT_2H = 2 * 3600;     // customer silent -> admin may approve on behalf
const CUSTOMER_SILENT_8H = 8 * 3600;     // still silent -> overdue, flagged as critical
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CATEGORIES = [
  'Water tastes salty / high TDS',
  'Low or no water flow',
  'Pump not running / noisy',
  'Water leakage',
  'Machine not switching on',
  'Filter or membrane change due',
  'Device offline / no data',
  'Other',
];

const STATUS_LABELS = {
  open: 'Open — awaiting engineer',
  accepted: 'Engineer assigned',
  arrived: 'Engineer on site',
  work_done: 'Work done — awaiting customer',
  approved: 'Customer approved',
  reopened: 'Reopened — customer not satisfied',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

const TERMINAL = ['closed', 'cancelled'];

// action -> status it leads to, per current status
const TRANSITIONS = {
  open:      { accept: 'accepted', cancel: 'cancelled' },
  accepted:  { arrive: 'arrived', reassign: 'accepted', drop: 'open', cancel: 'cancelled' },
  arrived:   { work_done: 'work_done', reassign: 'accepted', drop: 'open', cancel: 'cancelled' },
  work_done: { approve: 'approved', approve_on_behalf: 'approved', not_satisfied: 'reopened', cancel: 'cancelled' },
  reopened:  { accept: 'accepted', cancel: 'cancelled' },
  approved:  { close: 'closed' },
  closed:    {},
  cancelled: {},
};

const ACTIONS = {
  accept:            { label: 'Assign engineer', needsEngineer: true },
  reassign:          { label: 'Reassign engineer', needsEngineer: true, needsNote: true },
  arrive:            { label: 'Mark arrived' },
  work_done:         { label: 'Mark work done' },
  approve:           { label: 'Customer approved', customerOnly: true },
  approve_on_behalf: { label: 'Approve on customer’s behalf', needsNote: true },
  not_satisfied:     { label: 'Customer not satisfied', needsNote: true },
  drop:              { label: 'Engineer dropped / unable', needsNote: true },
  close:             { label: 'Close ticket' },
  cancel:            { label: 'Cancel ticket', needsNote: true },
  note:              { label: 'Add note', needsNote: true },
};

const ATTENTION = {
  no_engineer_in_area:   { label: 'No registered engineer covers this area — register one', severity: 'critical' },
  no_accept_1min:        { label: 'No engineer has accepted (over 1 minute)', severity: 'critical' },
  customer_not_satisfied:{ label: 'Customer not satisfied — job reopened',      severity: 'critical' },
  engineer_late:         { label: 'Engineer is late for the promised arrival',  severity: 'warning' },
  customer_silent_2h:    { label: 'Customer has not responded for 2 hours',     severity: 'warning' },
  customer_silent_8h:    { label: 'Customer silent for 8 hours — overdue',      severity: 'critical' },
};

// ── pure helpers ─────────────────────────────────────────────────────────────

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Date parts in India time, regardless of where the server runs.
function istParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  return { year: Number(get('year')), month: get('month'), day: get('day') };
}

function formatTicketNo(year, seq, month, day) {
  return `${SERIES}${String(year % 100).padStart(2, '0')}${MIDDLE}${seq}${month}${day}`;
}

function toMs(v) { return v ? new Date(v).getTime() : null; }

// Which problem (if any) needs an admin's eyes right now.
function attentionFor(t, now, ctx) {
  if (!t || TERMINAL.includes(t.status)) return null;
  const nowMs = now.getTime();
  // Nobody registered covers this site: tell admin at once, not after a minute.
  if ((t.status === 'open' || t.status === 'reopened') && ctx && ctx.matches === 0) return 'no_engineer_in_area';
  if (t.status === 'open') {
    const since = toMs(t.open_since) ?? toMs(t.created_at);
    if ((nowMs - since) / 1000 >= NO_ACCEPT_SECONDS) return 'no_accept_1min';
  }
  if (t.status === 'reopened') return 'customer_not_satisfied';
  if (t.status === 'accepted' && t.eta_at && nowMs > toMs(t.eta_at)) return 'engineer_late';
  if (t.status === 'work_done' && t.work_done_at) {
    const sec = (nowMs - toMs(t.work_done_at)) / 1000;
    if (sec >= CUSTOMER_SILENT_8H) return 'customer_silent_8h';
    if (sec >= CUSTOMER_SILENT_2H) return 'customer_silent_2h';
  }
  return null;
}

function availableActions(ticket) {
  const next = TRANSITIONS[ticket.status] || {};
  const list = Object.keys(next)
    .filter(a => !ACTIONS[a].customerOnly)     // the customer's own approval comes from the app
    .map(a => ({ action: a, label: ACTIONS[a].label, needs_note: !!ACTIONS[a].needsNote, needs_engineer: !!ACTIONS[a].needsEngineer }));
  list.push({ action: 'note', label: ACTIONS.note.label, needs_note: true, needs_engineer: false });
  return list;
}

function decorate(t, now, ctx) {
  const att = attentionFor(t, now, ctx);
  return {
    ...t,
    status_label: STATUS_LABELS[t.status] || t.status,
    age_seconds: Math.max(0, Math.round((now.getTime() - toMs(t.created_at)) / 1000)),
    attention: att,
    attention_label: att ? ATTENTION[att].label : null,
    attention_severity: att ? ATTENTION[att].severity : null,
  };
}

function sortForBoard(list) {
  const rank = t => (t.attention ? (t.attention_severity === 'critical' ? 0 : 1) : 2);
  return [...list].sort((a, b) =>
    rank(a) - rank(b) ||
    (a.urgency === 'urgent' ? 0 : 1) - (b.urgency === 'urgent' ? 0 : 1) ||
    toMs(a.created_at) - toMs(b.created_at));
}

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function snapshotOf(customer, now) {
  const sd = customer.sensor_data || {};
  const seen = toMs(customer.last_seen);
  return {
    captured_at: now.toISOString(),
    last_seen: customer.last_seen || null,
    device_online: seen != null && now.getTime() - seen <= ONLINE_WINDOW_MS,
    output_tds: customer.last_tds ?? null,
    feed_tds: sd.feed_tds ?? null,
    output_flow: sd.output_flow ?? null,
    reject_flow: sd.reject_flow ?? null,
    reject_ratio: sd.reject_ratio ?? null,
    membrane_health: sd.membrane_health ?? null,
    rejection_rate: sd.rejection_rate ?? null,
    pump_current: sd.pump_current ?? null,
    pump_status: customer.pump_status ?? sd.pump_status ?? null,
    pump_baseline: customer.pump_baseline ?? sd.pump_baseline ?? null,
    connection_type: customer.connection_type ?? null,
    network_name: customer.network_name ?? null,
    note: 'Indicative readings (about ±10%), not a lab test.',
  };
}

// ── service (all rules live here; the store is the only thing that touches the DB) ──

function siteOf(t) {
  return { pincode: t.pincode, latitude: t.latitude, longitude: t.longitude };
}

function createTicketService(store, { now = () => new Date() } = {}) {
  // How many registered, active engineers cover each ticket's site (live, never stale).
  async function contextFor() {
    const engineers = await store.listActiveEngineers();
    return {
      engineers,
      of: (t) => ({ matches: rankEngineers(siteOf(t), engineers).matches }),
    };
  }

  async function create(input, actor) {
    const customerId = String(input.customer_id || '');
    if (!UUID_RE.test(customerId)) throw httpError(400, 'Choose a store for this complaint.');

    const description = cleanText(input.description, 1000);
    if (!description) throw httpError(400, 'Describe the issue.');

    const category = input.issue_category ? cleanText(input.issue_category, 80) : 'Other';
    if (!CATEGORIES.includes(category)) throw httpError(400, 'Unknown issue type.');

    const urgency = input.urgency === 'urgent' ? 'urgent' : 'normal';

    const customer = await store.getCustomer(customerId);
    if (!customer) throw httpError(404, 'That store was not found.');

    const at = now();
    const { year, month, day } = istParts(at);
    const seq = await store.nextSeq(SERIES, START_SEQ);   // one continuous counter, not per year
    const ticketNo = formatTicketNo(year, seq, month, day);

    const contactPerson = cleanText(input.contact_person, 120) || customer.name || null;
    const contactPhone = cleanText(input.contact_phone, 30) || customer.phone || null;
    const address = [customer.address, customer.city].filter(Boolean).join(', ') || null;

    const row = await store.insertTicket({
      ticket_no: ticketNo, series: SERIES, year, seq,
      customer_id: customer.id, device_id: customer.device_id || null,
      status: 'open', urgency, source: 'admin',
      issue_category: category, description,
      site_name: customer.name || null,
      contact_person: contactPerson, contact_phone: contactPhone,
      address, pincode: customer.pincode || null,
      latitude: customer.latitude ?? null, longitude: customer.longitude ?? null,
      device_snapshot: snapshotOf(customer, at),
      raised_by: actor.email,
      open_since: at.toISOString(), created_at: at.toISOString(),
    });

    await store.insertEvent({
      ticket_id: row.id, actor: actor.email, actor_role: actor.role,
      action: 'created', from_status: null, to_status: 'open',
      note: `${category}${urgency === 'urgent' ? ' (urgent)' : ''}`,
      meta: { ticket_no: ticketNo, source: 'admin' },
    });
    const ctx = await contextFor();
    return decorate(row, at, ctx.of(row));
  }

  async function act(id, input, actor) {
    if (!UUID_RE.test(String(id))) throw httpError(400, 'Invalid ticket.');
    const ticket = await store.getTicket(id);
    if (!ticket) throw httpError(404, 'Ticket not found.');

    const action = String(input.action || '');
    const def = ACTIONS[action];
    if (!def || def.customerOnly) throw httpError(400, 'Unknown action.');

    const note = cleanText(input.note, 1000);
    const at = now();
    const iso = at.toISOString();

    if (action === 'note') {
      if (!note) throw httpError(400, 'Write the note first.');
      await store.insertEvent({
        ticket_id: ticket.id, actor: actor.email, actor_role: actor.role,
        action: 'note', from_status: ticket.status, to_status: ticket.status, note, meta: null,
      });
      const c0 = await contextFor();
      return decorate(ticket, at, c0.of(ticket));
    }

    const to = (TRANSITIONS[ticket.status] || {})[action];
    if (!to) throw httpError(409, `Can't "${def.label}" while the ticket is "${STATUS_LABELS[ticket.status]}".`);
    if (def.needsNote && !note) throw httpError(400, 'A note is required for this action.');

    const patch = { status: to };
    const meta = {};

    if (def.needsEngineer) {
      // Only a REGISTERED, ACTIVE engineer can take a complaint. Free-text names are not accepted.
      const engId = String(input.engineer_id || '');
      if (!UUID_RE.test(engId)) throw httpError(400, 'Choose a registered engineer. Register them first under Engineers.');
      const eng = await store.getEngineer(engId);
      if (!eng) throw httpError(404, 'That engineer is not registered.');
      if (eng.status !== 'active') throw httpError(409, `${eng.name} is blocked and cannot be assigned.`);
      patch.engineer_id = eng.id;
      patch.engineer_name = eng.name;
      patch.engineer_phone = eng.phone;
      patch.accepted_at = iso;
      patch.arrived_at = null;
      const mins = Number(input.eta_minutes);
      patch.eta_at = Number.isFinite(mins) && mins > 0 && mins <= 1440
        ? new Date(at.getTime() + mins * 60000).toISOString() : null;
      meta.engineer = eng.name;
      meta.engineer_id = eng.id;
      meta.engineer_code = eng.engineer_code;
      if (patch.eta_at) meta.eta_at = patch.eta_at;
    }

    switch (action) {
      case 'arrive':            patch.arrived_at = iso; break;
      case 'work_done':         patch.work_done_at = iso; break;
      case 'approve':           patch.approved_at = iso; patch.customer_response = 'approved'; break;
      case 'approve_on_behalf': patch.approved_at = iso; patch.customer_response = 'approved_by_admin'; patch.customer_reason = note; break;
      case 'not_satisfied':     patch.customer_response = 'not_satisfied'; patch.customer_reason = note; patch.work_done_at = null; break;
      case 'drop':
        patch.engineer_id = null; patch.engineer_name = null; patch.engineer_phone = null; patch.eta_at = null;
        patch.open_since = iso; break;
      case 'close':             patch.closed_at = iso; patch.closed_reason = note || null; break;
      case 'cancel':            patch.closed_at = iso; patch.closed_reason = note; break;
      default: break;
    }

    const merged = { ...ticket, ...patch };
    const ctx = await contextFor();
    const att = attentionFor(merged, at, ctx.of(merged));
    patch.attention_reason = att;
    patch.attention_at = att ? (att === ticket.attention_reason ? ticket.attention_at : iso) : null;

    // compare-and-set on status: if someone else moved the ticket first, we refuse
    const updated = await store.updateTicketIfStatus(ticket.id, ticket.status, patch);
    if (!updated) throw httpError(409, 'Someone else just changed this ticket. Reload and try again.');

    await store.insertEvent({
      ticket_id: ticket.id, actor: actor.email, actor_role: actor.role,
      action, from_status: ticket.status, to_status: to, note: note || null,
      meta: Object.keys(meta).length ? meta : null,
    });
    return decorate(updated, at, ctx.of(updated));
  }

  async function list(filter) {
    const at = now();
    let rows;
    if (filter === 'closed') rows = await store.listClosed(200);
    else if (filter === 'all') rows = [...(await store.listActive()), ...(await store.listClosed(100))];
    else rows = await store.listActive();
    const ctx = await contextFor();
    const decorated = rows.map(r => decorate(r, at, ctx.of(r)));
    return filter === 'closed'
      ? decorated.sort((a, b) => toMs(b.closed_at || b.created_at) - toMs(a.closed_at || a.created_at))
      : sortForBoard(decorated);
  }

  async function detail(id) {
    if (!UUID_RE.test(String(id))) throw httpError(400, 'Invalid ticket.');
    const at = now();
    const ticket = await store.getTicket(id);
    if (!ticket) throw httpError(404, 'Ticket not found.');
    const events = await store.listEvents(ticket.id);
    const ctx = await contextFor();
    const ranked = rankEngineers(siteOf(ticket), ctx.engineers);
    return {
      ticket: decorate(ticket, at, ctx.of(ticket)), events, actions: availableActions(ticket),
      candidates: { recommended: ranked.recommended, statewide: ranked.statewide, others: ranked.others },
    };
  }

  async function summary() {
    const at = now();
    const ctx = await contextFor();
    const active = (await store.listActive()).map(r => decorate(r, at, ctx.of(r)));
    const todayStart = new Date(`${istParts(at).year}-${istParts(at).month}-${istParts(at).day}T00:00:00+05:30`);
    const closedToday = (await store.listClosed(300))
      .filter(t => t.status === 'closed' && toMs(t.closed_at) >= todayStart.getTime()).length;
    const attention = active.filter(t => t.attention);
    return {
      open: active.filter(t => t.status === 'open').length,
      in_progress: active.filter(t => t.status === 'accepted' || t.status === 'arrived').length,
      awaiting_customer: active.filter(t => t.status === 'work_done').length,
      to_close: active.filter(t => t.status === 'approved').length,
      needs_attention: attention.length,
      closed_today: closedToday,
      open_ids: active.filter(t => t.status === 'open').map(t => t.id),
      attention: attention.map(t => ({
        id: t.id, ticket_no: t.ticket_no, site_name: t.site_name, reason: t.attention,
        label: t.attention_label, severity: t.attention_severity,
      })),
      at: at.toISOString(),
    };
  }

  // Run every minute: stores the "needs attention" flag and logs it once per change.
  async function runWatcher() {
    const at = now();
    const iso = at.toISOString();
    let changed = 0;
    const ctx = await contextFor();
    for (const t of await store.listActive()) {
      const att = attentionFor(t, at, ctx.of(t));
      if ((att || null) === (t.attention_reason || null)) continue;
      const patch = { attention_reason: att, attention_at: att ? iso : null };
      const ok = await store.updateTicketIfStatus(t.id, t.status, patch);
      if (!ok) continue;
      await store.insertEvent({
        ticket_id: t.id, actor: 'system', actor_role: 'system',
        action: att ? 'attention' : 'attention_cleared',
        from_status: t.status, to_status: t.status,
        note: att ? ATTENTION[att].label : 'No longer needs attention',
        meta: att ? { reason: att } : null,
      });
      changed += 1;
    }
    return changed;
  }

  return { create, act, list, detail, summary, runWatcher };
}

// ── Supabase-backed store ────────────────────────────────────────────────────

function supabaseStore(sb) {
  const fail = (error) => {
    // Table or function missing = the SQL migration hasn't been run yet.
    const missing = error && (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST202' || error.code === '42883');
    const e = httpError(missing ? 503 : 500,
      missing ? 'Tickets are not set up yet. Run the SQL migration in Supabase first.' : 'Database error.');
    e.detail = error && error.message;
    return e;
  };
  const one = async (q) => { const { data, error } = await q; if (error) throw fail(error); return data; };

  const COLS = 'id,name,phone,address,city,pincode,latitude,longitude,device_id,last_tds,last_seen,sensor_data,connection_type,network_name,pump_baseline,pump_status';

  return {
    async nextSeq(series, start) {
      // p_year is always 0: the counter is one row per series, so it never resets in January.
      const { data, error } = await sb.rpc('next_ticket_seq', { p_series: series, p_year: 0, p_start: start });
      if (error) throw fail(error);
      return data;
    },
    getCustomer: (id) => one(sb.from('customers').select(COLS).eq('id', id).maybeSingle()),
    insertTicket: (row) => one(sb.from('tickets').insert([row]).select().single()),
    getTicket: (id) => one(sb.from('tickets').select('*').eq('id', id).maybeSingle()),
    updateTicketIfStatus: (id, status, patch) =>
      one(sb.from('tickets').update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id).eq('status', status).select().maybeSingle()),
    listActive: () => one(sb.from('tickets').select('*')
      .not('status', 'in', '(closed,cancelled)').order('created_at', { ascending: true }).limit(500)),
    listClosed: (n) => one(sb.from('tickets').select('*')
      .in('status', ['closed', 'cancelled']).order('closed_at', { ascending: false }).limit(n)),
    async insertEvent(e) { await one(sb.from('ticket_events').insert([e])); },
    listEvents: (ticketId) => one(sb.from('ticket_events').select('*').eq('ticket_id', ticketId).order('at', { ascending: true })),
  };
}

// ── HTTP layer ───────────────────────────────────────────────────────────────

function createTicketsRouter(service) {
  const router = express.Router();
  const actorOf = (req) => ({
    email: (req.admin && req.admin.email) || 'unknown',
    role: (req.admin && req.admin.role) || 'unknown',
  });
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      if (!err.status || err.status >= 500) console.error('[TICKETS]', err.message, err.detail || '');
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong.' });
    }
  };

  router.get('/meta', wrap(async () => ({
    categories: CATEGORIES, statuses: STATUS_LABELS,
    attention: Object.fromEntries(Object.entries(ATTENTION).map(([k, v]) => [k, v.label])),
  })));
  router.get('/summary', wrap(() => service.summary()));
  router.get('/', wrap(async (req) => ({ tickets: await service.list(req.query.filter) })));
  router.post('/', wrap(async (req) => ({ ticket: await service.create(req.body || {}, actorOf(req)) })));
  router.get('/:id', wrap((req) => service.detail(req.params.id)));
  router.post('/:id/action', wrap(async (req) => ({ ticket: await service.act(req.params.id, req.body || {}, actorOf(req)) })));
  return router;
}

function startTicketWatcher(service, cron) {
  cron.schedule('* * * * *', async () => {
    try { await service.runWatcher(); } catch (err) { console.error('[TICKETS] watcher:', err.message); }
  });
}

module.exports = {
  SERIES, MIDDLE, START_SEQ, CATEGORIES, TRANSITIONS, ACTIONS,
  istParts, formatTicketNo, attentionFor, availableActions, snapshotOf,
  createTicketService, supabaseStore, createTicketsRouter, startTicketWatcher,
};
