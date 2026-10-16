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
const crypto = require('crypto');
const { rankEngineers, coverageOf, haversineKm } = require('./engineers');
const { ARRIVAL_RADIUS_M, CHECKLIST, NO_GPS_REASONS } = require('./fieldRules');

const SERIES = 'PMR';
const MIDDLE = '117';
const START_SEQ = 9000;

const ONLINE_WINDOW_MS = 10 * 60 * 1000;
const NO_ACCEPT_SECONDS = 60;            // unaccepted for 1 minute -> admin alert
const CUSTOMER_SILENT_2H = 2 * 3600;     // customer silent -> admin may approve on behalf
const CUSTOMER_SILENT_8H = 8 * 3600;     // still silent -> overdue, flagged as critical
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PHOTO_BUCKET = 'job-photos';
const PHOTO_KINDS = ['before', 'after', 'other'];
const PHOTO_MIMES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };
const VIDEO_EXTS = ['mp4', 'mov'];
const MAX_VIDEOS_PER_JOB = 3;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;   // short, compressed clips keep storage small
const PHOTO_PATH_RE = /^jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f-]{36}\.(jpg|png|webp|mp4|mov)$/;
const MAX_PHOTOS_PER_JOB = 20;   // photos; videos are counted separately
const PHOTO_VIEW_SECONDS = 600;
const ENGINEER_ACTIONS = ['arrive', 'work_done', 'drop', 'note'];
const WORKING = ['accepted', 'arrived', 'work_done', 'reopened'];
const MEDIA_OPEN = ['accepted', 'arrived', 'work_done', 'reopened', 'approved'];   // photos can be added until the report is filed
const CONTACT_VISIBLE = ['accepted', 'arrived', 'reopened'];   // engineer sees contact details only while doing the job

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
  open:      { accept: 'accepted', cancel: 'cancelled', customer_cancel: 'cancelled' },
  accepted:  { arrive: 'arrived', reassign: 'accepted', drop: 'open', cancel: 'cancelled', customer_cancel: 'cancelled' },
  arrived:   { work_done: 'work_done', reassign: 'accepted', drop: 'open', cancel: 'cancelled' },
  work_done: { approve: 'approved', approve_on_behalf: 'approved', engineer_override: 'approved', not_satisfied: 'reopened', cancel: 'cancelled' },
  reopened:  { accept: 'accepted', cancel: 'cancelled', customer_cancel: 'cancelled' },
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
  engineer_override: { label: 'Engineer proceeded without customer approval', needsNote: true, engineerOnly: true },
  not_satisfied:     { label: 'Customer not satisfied', needsNote: true },
  drop:              { label: 'Engineer dropped / unable', needsNote: true },
  close:             { label: 'Close ticket' },
  cancel:            { label: 'Cancel ticket', needsNote: true },
  customer_cancel:   { label: 'Customer cancelled the request', customerOnly: true },
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

// 'photo' or 'video', from the stored row (or, for older rows, from the file extension).
function mediaOf(p) {
  if (p.media_type) return p.media_type;
  return VIDEO_EXTS.includes(String(p.path || '').split('.').pop()) ? 'video' : 'photo';
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
    .filter(a => !ACTIONS[a].customerOnly && !ACTIONS[a].engineerOnly)     // the customer's own approval comes from the app
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

function createTicketService(store, { now = () => new Date(), push = null, mail = null } = {}) {
  // How many registered, active engineers cover each ticket's site (live, never stale).
  async function contextFor() {
    const engineers = await store.listActiveEngineers();
    return {
      engineers,
      of: (t) => ({ matches: rankEngineers(siteOf(t), engineers).matches }),
    };
  }

  async function create(input, actor, opts = {}) {
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
      status: 'open', urgency, source: opts.source === 'customer_app' ? 'customer_app' : 'admin',
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
      meta: { ticket_no: ticketNo, source: opts.source === 'customer_app' ? 'customer_app' : 'admin' },
    });
    const ctx = await contextFor();
    if (mail) mail.created(row);
    if (push) {
      const onDuty = new Set(ctx.engineers.filter(e => e.on_duty !== false).map(e => e.id));
      const ids = rankEngineers(siteOf(row), ctx.engineers).recommended.map(e => e.id).filter(id => onDuty.has(id));
      push.newComplaint(row, ids);                     // fire and forget; never blocks the ticket
    }
    return decorate(row, at, ctx.of(row));
  }

  async function act(id, input, actor) {
    if (!UUID_RE.test(String(id))) throw httpError(400, 'Invalid ticket.');
    const ticket = await store.getTicket(id);
    if (!ticket) throw httpError(404, 'Ticket not found.');

    const action = String(input.action || '');
    const def = ACTIONS[action];
    if (!def || (def.customerOnly && actor.role !== 'customer') || (def.engineerOnly && actor.role !== 'engineer')) throw httpError(400, 'Unknown action.');

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
      case 'engineer_override': patch.approved_at = iso; patch.customer_response = 'bypassed_by_engineer'; patch.customer_reason = note; break;
      case 'not_satisfied':     patch.customer_response = 'not_satisfied'; patch.customer_reason = note; patch.work_done_at = null; break;
      case 'drop':
        patch.engineer_id = null; patch.engineer_name = null; patch.engineer_phone = null; patch.eta_at = null;
        patch.open_since = iso; break;
      case 'close':             patch.closed_at = iso; patch.closed_reason = note || null; break;
      case 'cancel':            patch.closed_at = iso; patch.closed_reason = note; break;
      case 'customer_cancel':   patch.closed_at = iso; patch.closed_reason = note ? `Cancelled by customer: ${note}` : 'Cancelled by customer'; break;
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
    if (mail) {
      if (action === 'accept' || action === 'reassign') mail.assigned(updated);
      if (action === 'work_done') mail.workDone(updated);
      if (action === 'not_satisfied') mail.reopened(updated);
      if (action === 'customer_cancel') mail.cancelled(updated);
    }
    if (push && actor.role !== 'engineer') {
      if (action === 'accept' || action === 'reassign') push.assigned(updated, updated.engineer_id);
    }
    if (push && action === 'not_satisfied' && updated.engineer_id) push.reopened(updated, updated.engineer_id);
    if (push && action === 'customer_cancel' && updated.engineer_id) push.cancelled(updated, updated.engineer_id);
    return decorate(updated, at, ctx.of(updated));
  }

  async function list(filter) {
    const at = now();
    let rows;
    if (filter === 'closed') rows = await store.listClosed(200);
    else if (filter === 'all') rows = [...(await store.listActive()), ...(await store.listClosed(300))];   // 'all' also feeds search
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
    let photos = [];
    try { photos = await photosOf(ticket.id, true); } catch { /* photos are optional; never break the ticket view */ }
    return {
      ticket: decorate(ticket, at, ctx.of(ticket)), events, actions: availableActions(ticket), photos,
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
      if (mail && att === 'engineer_late') mail.delayed({ ...t, ...patch });
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

  // ── what an ENGINEER may see and do (used by the engineer app) ──────────────

  const engActor = (eng) => ({ email: `${eng.name} (${eng.engineer_code})`, role: 'engineer' });

  function offerView(t, cov, at) {
    // Before accepting, only the area and the issue are shown — no name, phone or address.
    return {
      id: t.id, ticket_no: t.ticket_no, urgency: t.urgency, issue_category: t.issue_category,
      description: t.description, pincode: t.pincode, distance_label: cov.label,
      created_at: t.created_at, age_seconds: Math.max(0, Math.round((at.getTime() - toMs(t.created_at)) / 1000)),
    };
  }

  async function photosOf(ticketId, withUrls) {
    const rows = await store.listPhotos(ticketId);
    if (!withUrls) return rows.map(p => ({ id: p.id, kind: p.kind, media_type: mediaOf(p), caption: p.caption, created_at: p.created_at }));
    return Promise.all(rows.map(async (p) => ({
      id: p.id, kind: p.kind, media_type: mediaOf(p), caption: p.caption, created_at: p.created_at,
      url: await store.signedReadUrl(PHOTO_BUCKET, p.path, PHOTO_VIEW_SECONDS),
    })));
  }

  async function jobView(t, at, withUrls) {
    const d = decorate(t, at);
    return {
      id: t.id, ticket_no: t.ticket_no, status: t.status, status_label: d.status_label,
      urgency: t.urgency, issue_category: t.issue_category, description: t.description,
      site_name: t.site_name,
      // Privacy: the customer's contact person and number are shown only while the job is being done.
      contact_person: CONTACT_VISIBLE.includes(t.status) ? t.contact_person : null,
      contact_phone: CONTACT_VISIBLE.includes(t.status) ? t.contact_phone : null,
      address: t.address, pincode: t.pincode, latitude: t.latitude, longitude: t.longitude,
      device_snapshot: t.device_snapshot, eta_at: t.eta_at, created_at: t.created_at,
      accepted_at: t.accepted_at, arrived_at: t.arrived_at, work_done_at: t.work_done_at,
      customer_response: t.customer_response, customer_reason: t.customer_reason,
      photos: await photosOf(t.id, withUrls),
    };
  }

  // same customer had a finished service in the last 30 days: quality / warranty flag
  async function repeatOf(t, at) {
    if (!store.listByCustomer || !t.customer_id) return false;
    const cutoff = at.getTime() - 30 * 86400000;
    const rows = await store.listByCustomer(t.customer_id, 10);
    return rows.some(x => x.id !== t.id && x.status === 'closed' && toMs(x.closed_at) >= cutoff);
  }

  async function engineerJobs(eng) {
    const at = now();
    const declined = new Set(await store.listDeclinedTicketIds(eng.id));
    const active = await store.listActive();
    const offers = [];
    const onDuty = eng.on_duty !== false;
    for (const t of active) {
      if (!onDuty) break;
      if (t.status !== 'open' && t.status !== 'reopened') continue;
      if (t.engineer_id === eng.id || declined.has(t.id)) continue;
      const cov = coverageOf(eng, siteOf(t));
      if (cov) offers.push({ ...offerView(t, cov, at), repeat_within_30d: await repeatOf(t, at) });
    }
    offers.sort((a, b) => (a.urgency === 'urgent' ? 0 : 1) - (b.urgency === 'urgent' ? 0 : 1) || toMs(a.created_at) - toMs(b.created_at));
    const mine = [];
    for (const t of active.filter(x => x.engineer_id === eng.id && (WORKING.includes(x.status) || x.status === 'approved'))) {
      mine.push(await jobView(t, at, false));
    }
    return { offers, mine, at: at.toISOString() };
  }

  async function engineerJob(eng, id) {
    if (!UUID_RE.test(String(id))) throw httpError(400, 'Invalid job.');
    const t = await store.getTicket(id);
    if (!t || t.engineer_id !== eng.id) throw httpError(404, 'This job is not assigned to you.');
    return jobView(t, now(), true);
  }

  async function engineerAct(eng, id, input) {
    if (!UUID_RE.test(String(id))) throw httpError(400, 'Invalid job.');
    const action = String(input.action || '');
    const t = await store.getTicket(id);
    if (!t) throw httpError(404, 'Job not found.');
    const actor = engActor(eng);

    if (action === 'accept') {
      if (!['open', 'reopened'].includes(t.status)) throw httpError(409, 'This complaint was just taken by another engineer.');
      if (t.engineer_id !== eng.id && !coverageOf(eng, siteOf(t))) throw httpError(403, 'This complaint is outside your area.');
      try {
        await act(id, { action: 'accept', engineer_id: eng.id, eta_minutes: input.eta_minutes }, actor);
      } catch (err) {
        if (err.status === 409) throw httpError(409, 'This complaint was just taken by another engineer.');
        throw err;
      }
      return engineerJob(eng, id);
    }

    if (action === 'decline') {
      if (!['open', 'reopened'].includes(t.status)) throw httpError(409, 'This complaint is no longer open.');
      if (!coverageOf(eng, siteOf(t))) throw httpError(403, 'This complaint is outside your area.');
      const reason = cleanText(input.reason, 300) || null;
      await store.insertDecline({ ticket_id: id, engineer_id: eng.id, reason });
      await store.insertEvent({
        ticket_id: id, actor: actor.email, actor_role: 'engineer', action: 'declined',
        from_status: t.status, to_status: t.status, note: reason, meta: { engineer_id: eng.id },
      });
      return { declined: true };
    }

    if (!ENGINEER_ACTIONS.includes(action)) throw httpError(400, 'That action is not available to engineers.');
    if (t.engineer_id !== eng.id) throw httpError(403, 'This job is not assigned to you.');

    let note = input.note;
    if (action === 'arrive') note = arrivalNote(t, input);
    if (action === 'work_done') {
      const ticks = input.checklist && typeof input.checklist === 'object' ? input.checklist : {};
      if (!CHECKLIST.every(c => ticks[c.key] === true)) throw httpError(400, 'Please tick every item in the checklist before marking the work done.');
    }
    await act(id, { action, note }, actor);
    if (action === 'work_done') {
      await store.insertEvent({
        ticket_id: id, actor: actor.email, actor_role: 'engineer', action: 'checklist',
        from_status: 'work_done', to_status: 'work_done', note: `${CHECKLIST.length} of ${CHECKLIST.length} steps completed`,
        meta: { checklist: CHECKLIST.map(c => c.key) },
      });
    }
    return engineerJob(eng, id);
  }

  // "Arrived" counts only at the site. Without a position, the engineer must say why.
  function arrivalNote(t, input) {
    const siteHas = t.latitude != null && t.longitude != null;
    if (!siteHas) return 'arrived (site has no map position)';
    const lat = Number(input.lat); const lng = Number(input.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const m = haversineKm(lat, lng, Number(t.latitude), Number(t.longitude)) * 1000;
      if (m > ARRIVAL_RADIUS_M) {
        const far = m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
        throw httpError(409, `You are about ${far} from the site. Please reach the site, then tap Arrived.`);
      }
      return `arrived at site (${Math.round(m)} m from the pin)`;
    }
    const why = NO_GPS_REASONS.find(r => r.key === String(input.no_gps_reason || ''));
    if (!why) throw httpError(409, 'Please turn on your location so we can confirm you reached the site.');
    return `arrived without a location check: ${why.en}`;
  }

  async function engineerPhotoUpload(eng, id, input) {
    if (!UUID_RE.test(String(id))) throw httpError(400, 'Invalid job.');
    const t = await store.getTicket(id);
    if (!t || t.engineer_id !== eng.id) throw httpError(404, 'This job is not assigned to you.');
    if (!MEDIA_OPEN.includes(t.status)) throw httpError(409, 'Photos can only be added while the job is open.');
    const mime = String(input.content_type || '');
    if (!PHOTO_MIMES[mime]) throw httpError(400, 'Attach a JPG, PNG or WebP photo, or an MP4 / MOV video.');
    if (!PHOTO_KINDS.includes(input.kind)) throw httpError(400, 'Say whether this is a before, after or other photo.');
    const isVideo = VIDEO_EXTS.includes(PHOTO_MIMES[mime]);
    const existing = await store.listPhotos(id);
    const videos = existing.filter(p => mediaOf(p) === 'video').length;
    const photos = existing.length - videos;
    if (isVideo && videos >= MAX_VIDEOS_PER_JOB) throw httpError(409, `A job can have at most ${MAX_VIDEOS_PER_JOB} videos.`);
    if (!isVideo && photos >= MAX_PHOTOS_PER_JOB) throw httpError(409, `A job can have at most ${MAX_PHOTOS_PER_JOB} photos.`);
    const path = `jobs/${id}/${crypto.randomUUID()}.${PHOTO_MIMES[mime]}`;
    const slot = await store.createSignedUpload(PHOTO_BUCKET, path);
    return { path, token: slot.token, bucket: PHOTO_BUCKET, kind: input.kind, media_type: isVideo ? 'video' : 'photo',
      max_bytes: isVideo ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES };
  }

  async function engineerAddPhoto(eng, id, input) {
    if (!UUID_RE.test(String(id))) throw httpError(400, 'Invalid job.');
    const t = await store.getTicket(id);
    if (!t || t.engineer_id !== eng.id) throw httpError(404, 'This job is not assigned to you.');
    if (!MEDIA_OPEN.includes(t.status)) throw httpError(409, 'Photos can only be added while the job is open.');
    const path = String(input.path || '');
    const m = PHOTO_PATH_RE.exec(path);
    if (!m || m[1] !== id) throw httpError(400, 'That photo does not belong to this job. Upload it again.');
    if (!PHOTO_KINDS.includes(input.kind)) throw httpError(400, 'Say whether this is a before, after or other photo.');
    if (!(await store.objectExists(PHOTO_BUCKET, path))) throw httpError(400, 'The photo was not found. Upload it again.');
    const row = await store.insertPhoto({
      ticket_id: id, engineer_id: eng.id, kind: input.kind, path,
      media_type: VIDEO_EXTS.includes(m[2]) ? 'video' : 'photo',
      mime: PHOTO_MIMES[input.mime] ? input.mime : null, caption: cleanText(input.caption, 120) || null,
    });
    await store.insertEvent({
      ticket_id: id, actor: engActor(eng).email, actor_role: 'engineer', action: 'photo_added',
      from_status: t.status, to_status: t.status, note: null, meta: { kind: input.kind },
    });
    return { id: row.id, kind: row.kind, media_type: mediaOf(row), caption: row.caption, created_at: row.created_at };
  }

  // The engineer's finished jobs (what they took and resolved), newest first.
  async function engineerHistory(eng) {
    const rows = await store.listClosedByEngineer(eng.id, 100);
    return rows.map(t => ({
      id: t.id, ticket_no: t.ticket_no, site_name: t.site_name, address: t.address,
      issue_category: t.issue_category, accepted_at: t.accepted_at, work_done_at: t.work_done_at,
      closed_at: t.closed_at, report_no: `FSR-${t.ticket_no}`,
    }));
  }

  // The engineer's phone reports where it is while they are on the way (accepted / arrived).
  async function engineerLocation(eng, id, input) {
    if (!UUID_RE.test(String(id))) throw httpError(400, 'Invalid job.');
    const t = await store.getTicket(id);
    if (!t || t.engineer_id !== eng.id) throw httpError(404, 'This job is not assigned to you.');
    if (!['accepted', 'arrived'].includes(t.status)) return { ok: true, ignored: true };
    const lat = Number(input.lat); const lng = Number(input.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 6 || lat > 38 || lng < 68 || lng > 98) {
      throw httpError(400, 'That location is not valid.');
    }
    await store.setEngineerLocation(id, lat, lng, now().toISOString());
    return { ok: true };
  }

  // Performance numbers for one engineer (admin only).
  async function engineerScorecard(engineerId) {
    if (!UUID_RE.test(String(engineerId))) throw httpError(400, 'Invalid engineer.');
    const rows = await store.listByEngineer(engineerId, 1000);
    const done = rows.filter(t => t.status === 'closed');
    const mins = (a, b) => (toMs(a) != null && toMs(b) != null ? (toMs(a) - toMs(b)) / 60000 : null);
    const accept = rows.map(t => mins(t.accepted_at, t.open_since || t.created_at)).filter(v => v != null && v >= 0);
    const timed = rows.filter(t => t.eta_at && t.arrived_at);
    const onTime = timed.filter(t => toMs(t.arrived_at) <= toMs(t.eta_at) + 5 * 60000).length;
    const ratings = store.listRatings ? await store.listRatings(engineerId) : [];
    const rated = ratings.filter(r => r.rating != null);
    const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
    return {
      jobs_total: rows.length, jobs_done: done.length, jobs_active: rows.filter(t => !TERMINAL.includes(t.status)).length,
      avg_accept_minutes: avg(accept), on_time_pct: timed.length ? Math.round((onTime / timed.length) * 100) : null,
      avg_rating: avg(rated.map(r => r.rating)), ratings_count: rated.length,
      without_approval: ratings.filter(r => r.approval_mode === 'engineer_override').length,
    };
  }

  return {
    create, act, list, detail, summary, runWatcher,
    engineerJobs, engineerJob, engineerAct, engineerPhotoUpload, engineerAddPhoto,
    engineerHistory, engineerLocation, engineerScorecard,
  };
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
    listByEngineer: (engineerId, n) => one(sb.from('tickets').select('*').eq('engineer_id', engineerId)
      .order('created_at', { ascending: false }).limit(n)),
    listRatings: (engineerId) => one(sb.from('service_reports').select('rating,approval_mode').eq('engineer_id', engineerId)),
    listClosedByEngineer: (engineerId, n) => one(sb.from('tickets').select('*').eq('engineer_id', engineerId)
      .eq('status', 'closed').order('closed_at', { ascending: false }).limit(n)),
    async setEngineerLocation(id, lat, lng, at) {
      await one(sb.from('tickets').update({ eng_lat: lat, eng_lng: lng, eng_loc_at: at }).eq('id', id));
    },
    listByCustomer: (customerId, n) => one(sb.from('tickets').select('*').eq('customer_id', customerId)
      .order('created_at', { ascending: false }).limit(n)),
    async insertEvent(e) { await one(sb.from('ticket_events').insert([e])); },
    listEvents: (ticketId) => one(sb.from('ticket_events').select('*').eq('ticket_id', ticketId).order('at', { ascending: true })),
    insertPhoto: (row) => one(sb.from('ticket_photos').insert([row]).select().single()),
    listPhotos: (ticketId) => one(sb.from('ticket_photos').select('*').eq('ticket_id', ticketId).order('created_at', { ascending: true })),
    async insertDecline(row) { await one(sb.from('ticket_declines').upsert([row], { onConflict: 'ticket_id,engineer_id' })); },
    async listDeclinedTicketIds(engineerId) {
      return (await one(sb.from('ticket_declines').select('ticket_id').eq('engineer_id', engineerId))).map(r => r.ticket_id);
    },
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
  STATUS_LABELS, TERMINAL, SERIES, MIDDLE, START_SEQ, CATEGORIES, TRANSITIONS, ACTIONS,
  istParts, formatTicketNo, attentionFor, availableActions, snapshotOf, mediaOf, PHOTO_BUCKET, ONLINE_WINDOW_MS,
  createTicketService, supabaseStore, createTicketsRouter, startTicketWatcher,
};
