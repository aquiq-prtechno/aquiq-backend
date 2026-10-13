'use strict';
// Run:  node tests/tickets.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const T = require('../tickets');

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name + '  ->  ' + e.message]); }
}

// ── in-memory store (same interface as supabaseStore) ──
function memStore(customers) {
  const counters = {};
  const tickets = [];
  const events = [];
  let ev = 0;
  const copy = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);
  return {
    tickets, events,
    async nextSeq(series, start) {
      counters[series] = counters[series] == null ? start : counters[series] + 1;   // one counter, never resets
      return counters[series];
    },
    async getCustomer(id) { return copy(customers[id]) || null; },
    async insertTicket(row) {
      if (tickets.some(t => t.ticket_no === row.ticket_no)) throw new Error('duplicate ticket_no');
      const t = { id: `00000000-0000-4000-8000-${String(tickets.length + 1).padStart(12, '0')}`, ...copy(row) };
      tickets.push(t); return copy(t);
    },
    async getTicket(id) { return copy(tickets.find(t => t.id === id)) || null; },
    async updateTicketIfStatus(id, status, patch) {
      const t = tickets.find(x => x.id === id);
      if (!t || t.status !== status) return null;
      Object.assign(t, copy(patch)); return copy(t);
    },
    async listActive() { return copy(tickets.filter(t => !['closed', 'cancelled'].includes(t.status))); },
    async listClosed() { return copy(tickets.filter(t => ['closed', 'cancelled'].includes(t.status))); },
    async insertEvent(e) { events.push({ id: ++ev, at: new Date().toISOString(), ...copy(e) }); },
    async listEvents(id) { return copy(events.filter(e => e.ticket_id === id)); },
  };
}

const CUST = '11111111-1111-4111-8111-111111111111';
const customers = {
  [CUST]: {
    id: CUST, name: 'Hotel Saffron', phone: '9999900000', address: 'Sector 14', city: 'Gurgaon',
    pincode: '122001', latitude: 28.45, longitude: 77.02, device_id: 'AQ-PR51916-32-001001',
    last_tds: 212, last_seen: '2026-10-13T05:00:00.000Z',
    sensor_data: { feed_tds: 480, output_flow: 1.1, reject_flow: 2.9, pump_current: 3.4 },
    connection_type: 'wifi', network_name: 'SiteWiFi', pump_baseline: 2.1, pump_status: 'weak',
  },
};
const ADMIN = { email: 'info@prtechno.in', role: 'owner' };

function clock(iso) {
  let t = new Date(iso);
  return { now: () => new Date(t), set: (i) => { t = new Date(i); }, add: (sec) => { t = new Date(t.getTime() + sec * 1000); } };
}
const ok400 = async (p, code, re) => {
  try { await p; } catch (e) { assert.strictEqual(e.status, code, `status ${e.status}: ${e.message}`); if (re) assert.match(e.message, re); return; }
  assert.fail('expected an error');
};

(async () => {
  // ── numbering ──
  await test('number format: first ticket of 2026 on 13 Oct is PMR2611790001013', async () => {
    const c = clock('2026-10-13T06:00:00Z');
    const svc = T.createTicketService(memStore(customers), { now: c.now });
    const t = await svc.create({ customer_id: CUST, description: 'Water salty' }, ADMIN);
    assert.strictEqual(t.ticket_no, 'PMR2611790001013');
  });
  await test('counter runs on across days; date suffix follows the day', async () => {
    const c = clock('2026-10-13T06:00:00Z');
    const svc = T.createTicketService(memStore(customers), { now: c.now });
    const a = await svc.create({ customer_id: CUST, description: 'a' }, ADMIN);
    const b = await svc.create({ customer_id: CUST, description: 'b' }, ADMIN);
    c.set('2026-10-14T06:00:00Z');
    const d = await svc.create({ customer_id: CUST, description: 'c' }, ADMIN);
    assert.deepStrictEqual([a.ticket_no, b.ticket_no, d.ticket_no],
      ['PMR2611790001013', 'PMR2611790011013', 'PMR2611790021014']);
  });
  await test('date and year use India time (IST), not UTC', async () => {
    const c = clock('2026-12-31T19:00:00Z');           // = 1 Jan 2027, 00:30 IST
    const svc = T.createTicketService(memStore(customers), { now: c.now });
    const t = await svc.create({ customer_id: CUST, description: 'x' }, ADMIN);
    assert.strictEqual(t.ticket_no, 'PMR2711790000101');
  });
  await test('new year changes ONLY the year and the date; the counter runs straight on', async () => {
    const c = clock('2026-12-31T10:00:00Z');
    const svc = T.createTicketService(memStore(customers), { now: c.now });
    const a = await svc.create({ customer_id: CUST, description: 'a' }, ADMIN);
    const b = await svc.create({ customer_id: CUST, description: 'b' }, ADMIN);
    c.set('2027-01-05T10:00:00Z');
    const d = await svc.create({ customer_id: CUST, description: 'c' }, ADMIN);
    assert.deepStrictEqual([a.ticket_no, b.ticket_no, d.ticket_no],
      ['PMR2611790001231', 'PMR2611790011231', 'PMR2711790020105']);
    assert.strictEqual(d.seq, 9002);
  });
  await test('counter past 9999 still produces a clear number', async () => {
    assert.strictEqual(T.formatTicketNo(2026, 10000, '10', '13'), 'PMR261171000010' + '13');
  });

  // ── creation ──
  await test('creation copies site details and a device snapshot; logs an event', async () => {
    const store = memStore(customers);
    const svc = T.createTicketService(store, { now: clock('2026-10-13T06:00:00Z').now });
    const t = await svc.create({ customer_id: CUST, description: 'Water salty', issue_category: 'Water tastes salty / high TDS', urgency: 'urgent' }, ADMIN);
    assert.strictEqual(t.site_name, 'Hotel Saffron');
    assert.strictEqual(t.contact_person, 'Hotel Saffron');
    assert.strictEqual(t.pincode, '122001');
    assert.strictEqual(t.urgency, 'urgent');
    assert.strictEqual(t.device_snapshot.output_tds, 212);
    assert.strictEqual(t.device_snapshot.feed_tds, 480);
    assert.strictEqual(t.status, 'open');
    assert.strictEqual(store.events.length, 1);
    assert.strictEqual(store.events[0].action, 'created');
  });
  await test('creation rejects bad input', async () => {
    const svc = T.createTicketService(memStore(customers), { now: clock('2026-10-13T06:00:00Z').now });
    await ok400(svc.create({ customer_id: 'nope', description: 'x' }, ADMIN), 400);
    await ok400(svc.create({ customer_id: CUST, description: '   ' }, ADMIN), 400, /Describe/);
    await ok400(svc.create({ customer_id: CUST, description: 'x', issue_category: 'Made up' }, ADMIN), 400);
    await ok400(svc.create({ customer_id: '22222222-2222-4222-8222-222222222222', description: 'x' }, ADMIN), 404);
  });

  // ── workflow ──
  async function fresh() {
    const c = clock('2026-10-13T06:00:00Z');
    const store = memStore(customers);
    const svc = T.createTicketService(store, { now: c.now });
    const t = await svc.create({ customer_id: CUST, description: 'Low flow' }, ADMIN);
    return { c, store, svc, id: t.id };
  }
  await test('happy path: open → accepted → arrived → work_done → approved → closed', async () => {
    const { svc, id, store } = await fresh();
    let t = await svc.act(id, { action: 'accept', engineer_name: 'Ravi', engineer_phone: '9876543210', eta_minutes: 60 }, ADMIN);
    assert.strictEqual(t.status, 'accepted'); assert.strictEqual(t.engineer_name, 'Ravi'); assert.ok(t.eta_at);
    t = await svc.act(id, { action: 'arrive' }, ADMIN); assert.strictEqual(t.status, 'arrived');
    t = await svc.act(id, { action: 'work_done' }, ADMIN); assert.strictEqual(t.status, 'work_done');
    t = await svc.act(id, { action: 'approve_on_behalf', note: 'Confirmed by phone with Mr Sharma' }, ADMIN);
    assert.strictEqual(t.status, 'approved'); assert.strictEqual(t.customer_response, 'approved_by_admin');
    t = await svc.act(id, { action: 'close', note: 'Report PMR... filed' }, ADMIN);
    assert.strictEqual(t.status, 'closed'); assert.ok(t.closed_at);
    assert.deepStrictEqual(store.events.map(e => e.action), ['created', 'accept', 'arrive', 'work_done', 'approve_on_behalf', 'close']);
  });
  await test('rules: notes and engineer name are required where promised', async () => {
    const { svc, id } = await fresh();
    await ok400(svc.act(id, { action: 'accept' }, ADMIN), 400, /engineer/i);
    await ok400(svc.act(id, { action: 'cancel' }, ADMIN), 400, /note/i);
    await svc.act(id, { action: 'accept', engineer_name: 'Ravi' }, ADMIN);
    await svc.act(id, { action: 'arrive' }, ADMIN);
    await svc.act(id, { action: 'work_done' }, ADMIN);
    await ok400(svc.act(id, { action: 'approve_on_behalf' }, ADMIN), 400, /note/i);
    await ok400(svc.act(id, { action: 'not_satisfied' }, ADMIN), 400, /note/i);
  });
  await test('rules: skipping steps and the customer-only "approve" are refused', async () => {
    const { svc, id } = await fresh();
    await ok400(svc.act(id, { action: 'work_done' }, ADMIN), 409);     // not accepted yet
    await ok400(svc.act(id, { action: 'close' }, ADMIN), 409);
    await ok400(svc.act(id, { action: 'approve' }, ADMIN), 400);        // customer's own action
    await ok400(svc.act(id, { action: 'delete' }, ADMIN), 400);
  });
  await test('rules: a closed ticket cannot change, only take notes', async () => {
    const { svc, id } = await fresh();
    await svc.act(id, { action: 'cancel', note: 'duplicate' }, ADMIN);
    await ok400(svc.act(id, { action: 'accept', engineer_name: 'Ravi' }, ADMIN), 409);
    const t = await svc.act(id, { action: 'note', note: 'confirmed duplicate' }, ADMIN);
    assert.strictEqual(t.status, 'cancelled');
  });
  await test('drop: engineer removed, ticket returns to open, 1-minute clock restarts', async () => {
    const { svc, id, c } = await fresh();
    await svc.act(id, { action: 'accept', engineer_name: 'Ravi' }, ADMIN);
    c.add(3600);
    let t = await svc.act(id, { action: 'drop', note: 'vehicle broke down' }, ADMIN);
    assert.strictEqual(t.status, 'open'); assert.strictEqual(t.engineer_name, null);
    assert.strictEqual(t.attention, null, 'timer must restart from the drop, not the original creation');
    c.add(61);
    t = (await svc.list('active')).find(x => x.id === id);
    assert.strictEqual(t.attention, 'no_accept_1min');
  });
  await test('not satisfied: reopens, flagged critical, then can be reassigned', async () => {
    const { svc, id } = await fresh();
    await svc.act(id, { action: 'accept', engineer_name: 'Ravi' }, ADMIN);
    await svc.act(id, { action: 'arrive' }, ADMIN);
    await svc.act(id, { action: 'work_done' }, ADMIN);
    let t = await svc.act(id, { action: 'not_satisfied', note: 'still salty' }, ADMIN);
    assert.strictEqual(t.status, 'reopened'); assert.strictEqual(t.attention, 'customer_not_satisfied');
    t = await svc.act(id, { action: 'accept', engineer_name: 'Amit' }, ADMIN);
    assert.strictEqual(t.status, 'accepted'); assert.strictEqual(t.engineer_name, 'Amit');
  });
  await test('two admins act at the same instant: exactly one wins', async () => {
    const { svc, id } = await fresh();
    const r = await Promise.allSettled([
      svc.act(id, { action: 'accept', engineer_name: 'Ravi' }, ADMIN),
      svc.act(id, { action: 'accept', engineer_name: 'Amit' }, ADMIN),
    ]);
    // In-memory store runs the awaits in sequence; whichever runs second must be refused.
    assert.strictEqual(r.filter(x => x.status === 'fulfilled').length, 1);
    assert.strictEqual(r.filter(x => x.status === 'rejected')[0].reason.status, 409);
  });

  // ── timers ──
  await test('timers: 1 minute unaccepted → alert; accepted → cleared', async () => {
    const { svc, id, c } = await fresh();
    c.add(59);
    assert.strictEqual((await svc.list('active')).find(x => x.id === id).attention, null);
    c.add(2);
    assert.strictEqual((await svc.list('active')).find(x => x.id === id).attention, 'no_accept_1min');
    const t = await svc.act(id, { action: 'accept', engineer_name: 'Ravi' }, ADMIN);
    assert.strictEqual(t.attention, null);
  });
  await test('timers: engineer late after promised arrival', async () => {
    const { svc, id, c } = await fresh();
    await svc.act(id, { action: 'accept', engineer_name: 'Ravi', eta_minutes: 30 }, ADMIN);
    c.add(29 * 60);
    assert.strictEqual((await svc.list('active')).find(x => x.id === id).attention, null);
    c.add(2 * 60);
    assert.strictEqual((await svc.list('active')).find(x => x.id === id).attention, 'engineer_late');
  });
  await test('timers: customer silent 2 hours → warning, 8 hours → critical', async () => {
    const { svc, id, c } = await fresh();
    await svc.act(id, { action: 'accept', engineer_name: 'Ravi' }, ADMIN);
    await svc.act(id, { action: 'arrive' }, ADMIN);
    await svc.act(id, { action: 'work_done' }, ADMIN);
    c.add(2 * 3600 - 1);
    assert.strictEqual((await svc.list('active'))[0].attention, null);
    c.add(2);
    let t = (await svc.list('active'))[0];
    assert.strictEqual(t.attention, 'customer_silent_2h'); assert.strictEqual(t.attention_severity, 'warning');
    c.add(6 * 3600);
    t = (await svc.list('active'))[0];
    assert.strictEqual(t.attention, 'customer_silent_8h'); assert.strictEqual(t.attention_severity, 'critical');
  });
  await test('watcher: stores the flag and logs it once, not every minute', async () => {
    const { svc, id, c, store } = await fresh();
    c.add(61);
    assert.strictEqual(await svc.runWatcher(), 1);
    assert.strictEqual(await svc.runWatcher(), 0);
    c.add(60);
    assert.strictEqual(await svc.runWatcher(), 0);
    assert.strictEqual(store.events.filter(e => e.action === 'attention').length, 1);
    assert.strictEqual(store.tickets.find(t => t.id === id).attention_reason, 'no_accept_1min');
  });
  await test('board order: critical first, then urgent, then oldest', async () => {
    const c = clock('2026-10-13T06:00:00Z');
    const svc = T.createTicketService(memStore(customers), { now: c.now });
    const a = await svc.create({ customer_id: CUST, description: 'old normal' }, ADMIN);
    c.add(30);
    const b = await svc.create({ customer_id: CUST, description: 'urgent', urgency: 'urgent' }, ADMIN);
    await svc.act(a.id, { action: 'accept', engineer_name: 'R' }, ADMIN);   // a no longer unaccepted
    c.add(90);                                                              // b now >1 minute unaccepted
    const ids = (await svc.list('active')).map(t => t.id);
    assert.strictEqual(ids[0], b.id, 'the ticket with an active alert must be first');
  });
  await test('summary counts', async () => {
    const { svc, id, c } = await fresh();
    c.add(61);
    let s = await svc.summary();
    assert.deepStrictEqual([s.open, s.needs_attention, s.in_progress], [1, 1, 0]);
    await svc.act(id, { action: 'accept', engineer_name: 'R' }, ADMIN);
    s = await svc.summary();
    assert.deepStrictEqual([s.open, s.needs_attention, s.in_progress], [0, 0, 1]);
  });

  // ── HTTP layer ──
  await test('HTTP: create, list, detail, action; bad id and bad action return clean errors', async () => {
    const store = memStore(customers);
    const svc = T.createTicketService(store, { now: clock('2026-10-13T06:00:00Z').now });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.admin = ADMIN; next(); });
    app.use('/admin/tickets', T.createTicketsRouter(svc));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/admin/tickets`;
    const j = async (path, opt) => { const r = await fetch(base + path, opt); return { s: r.status, b: await r.json() }; };
    const post = (path, body) => j(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const created = await post('', { customer_id: CUST, description: 'Pump noisy', issue_category: 'Pump not running / noisy' });
      assert.strictEqual(created.s, 200);
      assert.strictEqual(created.b.ticket.ticket_no, 'PMR2611790001013');
      const id = created.b.ticket.id;
      assert.strictEqual((await j('')).b.tickets.length, 1);
      const d = await j('/' + id);
      assert.strictEqual(d.s, 200); assert.ok(d.b.actions.some(a => a.action === 'accept'));
      assert.ok(!d.b.actions.some(a => a.action === 'approve'), 'customer-only action must not be offered');
      assert.strictEqual((await post('/' + id + '/action', { action: 'accept' })).s, 400);
      assert.strictEqual((await post('/' + id + '/action', { action: 'accept', engineer_name: 'Ravi' })).s, 200);
      assert.strictEqual((await j('/not-a-uuid')).s, 400);
      assert.strictEqual((await post('', { description: 'x' })).s, 400);
      assert.strictEqual((await j('/meta')).b.categories.length, 8);
    } finally { server.close(); }
  });

  for (const [s, n] of results) console.log(`${s}  ${n}`);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})();
