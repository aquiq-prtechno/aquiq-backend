'use strict';
// Run:  node tests/tickets.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const T = require('../tickets');
const E = require('../engineers');

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
  const engineers = [];
  const engineerEvents = [];
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
    // ── engineers ──
    engineers, engineerEvents,
    async getEngineer(id) { return copy(engineers.find(e => e.id === id)) || null; },
    async findEngineerConflict(phone, proof, type) {
      return copy(engineers.find(e => e.phone === phone ||
        (e.id_proof_type === type && e.id_proof_ref.toLowerCase() === proof.toLowerCase()))) || null;
    },
    files: new Set(),
    async createSignedUpload(path) { return { path, token: 'upload-token' }; },
    async proofExists(path) { return this.files.has(path); },
    async signedReadUrl(path, secs) { return `https://signed.test/${path}?expires=${secs}`; },
    async insertEngineer(row) {
      const e = { id: `00000000-0000-4000-9000-${String(engineers.length + 1).padStart(12, '0')}`, ...copy(row) };
      engineers.push(e); return copy(e);
    },
    async updateEngineer(id, patch) { const e = engineers.find(x => x.id === id); Object.assign(e, copy(patch)); return copy(e); },
    async listEngineers() { return copy(engineers); },
    async listActiveEngineers() { return copy(engineers.filter(e => e.status === 'active')); },
    async insertEngineerEvent(e) { engineerEvents.push(copy(e)); },
    async listEngineerEvents(id) { return copy(engineerEvents.filter(e => e.engineer_id === id)); },
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
  let ravi, amit;   // ids of two registered engineers, set by fresh()
  async function fresh() {
    const c = clock('2026-10-13T06:00:00Z');
    const store = memStore(customers);
    const es = E.createEngineerService(store, { now: c.now });
    ravi = (await es.register({ name: 'Ravi', phone: '9876543210', pincode: '122001', id_proof_type: 'driving_licence', id_proof_ref: 'DL-1111' }, ADMIN)).id;
    amit = (await es.register({ name: 'Amit', phone: '9876500000', pincode: '110001', id_proof_type: 'driving_licence', id_proof_ref: 'DL-2222' }, ADMIN)).id;
    const svc = T.createTicketService(store, { now: c.now });
    const t = await svc.create({ customer_id: CUST, description: 'Low flow' }, ADMIN);
    return { c, store, svc, es, id: t.id };
  }
  await test('happy path: open → accepted → arrived → work_done → approved → closed', async () => {
    const { svc, id, store } = await fresh();
    let t = await svc.act(id, { action: 'accept', engineer_id: ravi, eta_minutes: 60 }, ADMIN);
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
    await ok400(svc.act(id, { action: 'accept' }, ADMIN), 400, /registered engineer/i);
    await ok400(svc.act(id, { action: 'cancel' }, ADMIN), 400, /note/i);
    await svc.act(id, { action: 'accept', engineer_id: ravi }, ADMIN);
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
    await ok400(svc.act(id, { action: 'accept', engineer_id: ravi }, ADMIN), 409);
    const t = await svc.act(id, { action: 'note', note: 'confirmed duplicate' }, ADMIN);
    assert.strictEqual(t.status, 'cancelled');
  });
  await test('drop: engineer removed, ticket returns to open, 1-minute clock restarts', async () => {
    const { svc, id, c } = await fresh();
    await svc.act(id, { action: 'accept', engineer_id: ravi }, ADMIN);
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
    await svc.act(id, { action: 'accept', engineer_id: ravi }, ADMIN);
    await svc.act(id, { action: 'arrive' }, ADMIN);
    await svc.act(id, { action: 'work_done' }, ADMIN);
    let t = await svc.act(id, { action: 'not_satisfied', note: 'still salty' }, ADMIN);
    assert.strictEqual(t.status, 'reopened'); assert.strictEqual(t.attention, 'customer_not_satisfied');
    t = await svc.act(id, { action: 'accept', engineer_id: amit }, ADMIN);
    assert.strictEqual(t.status, 'accepted'); assert.strictEqual(t.engineer_name, 'Amit');
  });
  await test('two admins act at the same instant: exactly one wins', async () => {
    const { svc, id } = await fresh();
    const r = await Promise.allSettled([
      svc.act(id, { action: 'accept', engineer_id: ravi }, ADMIN),
      svc.act(id, { action: 'accept', engineer_id: amit }, ADMIN),
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
    const t = await svc.act(id, { action: 'accept', engineer_id: ravi }, ADMIN);
    assert.strictEqual(t.attention, null);
  });
  await test('timers: engineer late after promised arrival', async () => {
    const { svc, id, c } = await fresh();
    await svc.act(id, { action: 'accept', engineer_id: ravi, eta_minutes: 30 }, ADMIN);
    c.add(29 * 60);
    assert.strictEqual((await svc.list('active')).find(x => x.id === id).attention, null);
    c.add(2 * 60);
    assert.strictEqual((await svc.list('active')).find(x => x.id === id).attention, 'engineer_late');
  });
  await test('timers: customer silent 2 hours → warning, 8 hours → critical', async () => {
    const { svc, id, c } = await fresh();
    await svc.act(id, { action: 'accept', engineer_id: ravi }, ADMIN);
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
    const store = memStore(customers);
    const r = await E.createEngineerService(store, { now: c.now }).register({ name: 'R Kumar', phone: '9812345678', pincode: '122001', id_proof_type: 'driving_licence', id_proof_ref: 'PAN-9999' }, ADMIN);
    const svc = T.createTicketService(store, { now: c.now });
    const a = await svc.create({ customer_id: CUST, description: 'old normal' }, ADMIN);
    c.add(30);
    const b = await svc.create({ customer_id: CUST, description: 'urgent', urgency: 'urgent' }, ADMIN);
    await svc.act(a.id, { action: 'accept', engineer_id: r.id }, ADMIN);   // a no longer unaccepted
    c.add(90);                                                              // b now >1 minute unaccepted
    const ids = (await svc.list('active')).map(t => t.id);
    assert.strictEqual(ids[0], b.id, 'the ticket with an active alert must be first');
  });
  await test('summary counts', async () => {
    const { svc, id, c } = await fresh();
    c.add(61);
    let s = await svc.summary();
    assert.deepStrictEqual([s.open, s.needs_attention, s.in_progress], [1, 1, 0]);
    await svc.act(id, { action: 'accept', engineer_id: ravi }, ADMIN);
    s = await svc.summary();
    assert.deepStrictEqual([s.open, s.needs_attention, s.in_progress], [0, 0, 1]);
  });

  // ── engineer register ──
  const EV = { name: 'Suresh Yadav', phone: '9811122233', pincode: '122001', id_proof_type: 'driving_licence', id_proof_ref: 'DL-0420110012345' };
  const mkEng = () => { const st = memStore(customers); return { st, es: E.createEngineerService(st, { now: clock('2026-10-13T06:00:00Z').now }) }; };

  await test('engineers: registered with sequential IDs ENG-1001, ENG-1002', async () => {
    const { es } = mkEng();
    const a = await es.register(EV, ADMIN);
    const b = await es.register({ ...EV, name: 'Mohan', phone: '9811122234', id_proof_type: 'driving_licence', id_proof_ref: 'DL-2-XXXXX' }, ADMIN);
    assert.deepStrictEqual([a.engineer_code, b.engineer_code], ['ENG-1001', 'ENG-1002']);
    assert.strictEqual(a.status, 'active'); assert.strictEqual(a.radius_km, 30);
  });
  await test('engineers: bad input is refused', async () => {
    const { es } = mkEng();
    await ok400(es.register({ ...EV, phone: '12345' }, ADMIN), 400, /10-digit/);
    await ok400(es.register({ ...EV, pincode: '12' }, ADMIN), 400, /pincode/i);
    await ok400(es.register({ ...EV, id_proof_ref: '' }, ADMIN), 400, /document number/);
    await ok400(es.register({ ...EV, name: 'A' }, ADMIN), 400, /name/i);
    await ok400(es.register({ ...EV, latitude: 51.5, longitude: -0.12 }, ADMIN), 400, /inside India/);
    await ok400(es.register({ ...EV, latitude: 28.4 }, ADMIN), 400, /both/i);
  });
  await test('engineers: same phone or same ID document cannot be registered twice', async () => {
    const { es } = mkEng();
    await es.register(EV, ADMIN);
    await ok400(es.register({ ...EV, name: 'Other', id_proof_type: 'driving_licence', id_proof_ref: 'DL-NEW-999' }, ADMIN), 409, /phone/);
    await ok400(es.register({ ...EV, phone: '9000000001', id_proof_ref: 'dl-0420110012345' }, ADMIN), 409, /ID document/);
  });
  await test('engineers: a blocked person can never register again', async () => {
    const { es } = mkEng();
    const e = await es.register(EV, ADMIN);
    await ok400(es.block(e.id, '', ADMIN), 400, /reason/);
    const b = await es.block(e.id, 'Did not turn up and lied about it', ADMIN);
    assert.strictEqual(b.status, 'blocked'); assert.ok(b.blocked_at);
    await ok400(es.register({ ...EV, name: 'Same Man New Name', id_proof_type: 'driving_licence', id_proof_ref: 'DL-BRAND-NEW' }, ADMIN), 409, /BLOCKED/);
    await ok400(es.register({ ...EV, phone: '9000000002' }, ADMIN), 409, /BLOCKED/);
    assert.strictEqual((await es.list('active')).length, 0);
    assert.strictEqual((await es.list('blocked')).length, 1);
  });
  await test('engineers: restore works; identity fields (phone, ID) cannot be edited', async () => {
    const { es, st } = mkEng();
    const e = await es.register(EV, ADMIN);
    await es.block(e.id, 'test', ADMIN);
    const r = await es.restore(e.id, 'cleared after review', ADMIN);
    assert.strictEqual(r.status, 'active'); assert.strictEqual(r.blocked_reason, null);
    await es.update(e.id, { phone: '9999999999', id_proof_type: 'driving_licence', id_proof_ref: 'HACK', city: 'Gurgaon', radius_km: 40 }, ADMIN);
    const after = (await es.detail(e.id)).engineer;
    assert.strictEqual(after.phone, EV.phone); assert.strictEqual(after.id_proof_ref, EV.id_proof_ref);
    assert.strictEqual(after.city, 'Gurgaon'); assert.strictEqual(after.radius_km, 40);
    assert.deepStrictEqual(st.engineerEvents.map(x => x.action), ['registered', 'blocked', 'restored', 'updated']);
  });
  await test('coverage: same pincode, within radius, outside, and state-wide are told apart', async () => {
    const site = { pincode: '122001', latitude: 28.45, longitude: 77.02 };
    const mk = (o) => ({ id: o.name, engineer_code: 'E', status: 'active', radius_km: 30, state_wide: false, ...o });
    const r = E.rankEngineers(site, [
      mk({ name: 'samepin', pincode: '122001' }),
      mk({ name: 'near', pincode: '122018', latitude: 28.5, longitude: 77.1 }),        // ~10 km
      mk({ name: 'faraway', pincode: '500001', latitude: 17.38, longitude: 78.48 }),   // Hyderabad
      mk({ name: 'wide', pincode: '500001', state_wide: true }),
      { ...mk({ name: 'blocked', pincode: '122001' }), status: 'blocked' },
    ]);
    assert.deepStrictEqual(r.recommended.map(x => x.name), ['samepin', 'near']);
    assert.strictEqual(r.recommended[0].basis, 'pincode');
    assert.strictEqual(r.recommended[1].basis, 'distance');
    assert.deepStrictEqual(r.statewide.map(x => x.name), ['wide']);
    assert.deepStrictEqual(r.others.map(x => x.name), ['faraway']);
    assert.strictEqual(r.matches, 2);
  });

  // ── ID document type and attached proof ──
  const withFile = (st, name = 'licence.jpg') => { const p = `engineers/44444444-4444-4444-8444-444444444444/${name}`; st.files.add(p); return p; };

  await test('proof: the document type must be chosen; Other needs a written name', async () => {
    const { es } = mkEng();
    await ok400(es.register({ ...EV, id_proof_type: '' }, ADMIN), 400, /Choose the ID document/);
    await ok400(es.register({ ...EV, id_proof_type: 'passport-ish' }, ADMIN), 400, /Choose the ID document/);
    await ok400(es.register({ ...EV, id_proof_type: 'other', id_proof_other: '' }, ADMIN), 400, /Write the name/);
    const e = await es.register({ ...EV, id_proof_type: 'other', id_proof_other: 'Voter ID card' }, ADMIN);
    assert.strictEqual(e.id_proof_type, 'other'); assert.strictEqual(e.id_proof_other, 'Voter ID card');
    const p = await mkEng().es.register({ ...EV, id_proof_type: 'pan', id_proof_other: 'ignored' }, ADMIN);
    assert.strictEqual(p.id_proof_other, null, 'the written name is kept only for type Other');
  });
  await test('proof: same number on a different document type is not a clash; same type is', async () => {
    const { es } = mkEng();
    await es.register({ ...EV, id_proof_type: 'pan', id_proof_ref: 'ABCDE1234F' }, ADMIN);
    const ok = await es.register({ ...EV, phone: '9000000010', id_proof_type: 'driving_licence', id_proof_ref: 'ABCDE1234F' }, ADMIN);
    assert.ok(ok.id);
    await ok400(es.register({ ...EV, phone: '9000000011', id_proof_type: 'pan', id_proof_ref: 'abcde1234f' }, ADMIN), 409, /ID document/);
  });
  await test('proof: only photos and PDFs can be attached; the upload path is unguessable and safe', async () => {
    const { es } = mkEng();
    await ok400(es.createProofUpload({ filename: 'virus.exe', content_type: 'application/x-msdownload' }), 400, /JPG, PNG/);
    const up = await es.createProofUpload({ filename: '../../etc/My Licence (front).JPG', content_type: 'image/jpeg' });
    assert.match(up.path, /^engineers\/[0-9a-f-]{36}\/[A-Za-z0-9._-]+\.jpg$/);
    assert.ok(!up.path.includes('..') && !up.path.includes(' '));
    assert.strictEqual(up.max_bytes, 5 * 1024 * 1024);
  });
  await test('proof: registering with a file that was never uploaded, or a forged path, is refused', async () => {
    const { es } = mkEng();
    await ok400(es.register({ ...EV, proof_path: 'engineers/44444444-4444-4444-8444-444444444444/missing.jpg' }, ADMIN), 400, /not found/);
    await ok400(es.register({ ...EV, proof_path: '../secrets/other.pdf' }, ADMIN), 400, /not valid/);
    await ok400(es.register({ ...EV, proof_path: 'engineers/not-a-uuid/x.jpg' }, ADMIN), 400, /not valid/);
  });
  await test('proof: attached at registration, viewed through a short private link that is logged', async () => {
    const { es, st } = mkEng();
    const e = await es.register({ ...EV, proof_path: withFile(st), proof_file_name: 'licence.jpg', proof_mime: 'image/jpeg' }, ADMIN);
    assert.strictEqual(e.proof_file_name, 'licence.jpg'); assert.ok(e.proof_uploaded_at);
    const v = await es.proofUrl(e.id, ADMIN);
    assert.match(v.url, /^https:\/\/signed\.test\/engineers\//); assert.strictEqual(v.expires_in, 300);
    assert.deepStrictEqual(st.engineerEvents.map(x => x.action), ['registered', 'proof_viewed']);
  });
  await test('proof: can be attached later; "no proof" is reported cleanly', async () => {
    const { es, st } = mkEng();
    const e = await es.register(EV, ADMIN);
    assert.strictEqual(e.proof_path, null);
    await ok400(es.proofUrl(e.id, ADMIN), 404, /No proof/);
    const after = await es.attachProof(e.id, { proof_path: withFile(st, 'later.pdf'), proof_file_name: 'later.pdf', proof_mime: 'application/pdf' }, ADMIN);
    assert.strictEqual(after.proof_mime, 'application/pdf');
    assert.ok((await es.proofUrl(e.id, ADMIN)).url);
    await ok400(es.attachProof(e.id, { proof_path: 'engineers/44444444-4444-4444-8444-444444444444/gone.pdf' }, ADMIN), 400, /not found/);
  });
  await test('proof: the document type and number cannot be edited afterwards', async () => {
    const { es } = mkEng();
    const e = await es.register(EV, ADMIN);
    await es.update(e.id, { id_proof_type: 'pan', id_proof_other: 'x', id_proof_ref: 'CHANGED', city: 'Delhi' }, ADMIN);
    const after = (await es.detail(e.id)).engineer;
    assert.strictEqual(after.id_proof_type, 'driving_licence'); assert.strictEqual(after.id_proof_ref, EV.id_proof_ref);
    assert.strictEqual(after.city, 'Delhi');
  });

  // ── assignment only from the register ──
  await test('assign: a typed name is refused; an unknown ID is refused', async () => {
    const { svc, id } = await fresh();
    await ok400(svc.act(id, { action: 'accept', engineer_name: 'Someone Typed', engineer_phone: '9999999999' }, ADMIN), 400, /registered engineer/);
    await ok400(svc.act(id, { action: 'accept', engineer_id: '33333333-3333-4333-8333-333333333333' }, ADMIN), 404, /not registered/);
  });
  await test('assign: a blocked engineer cannot be assigned', async () => {
    const { svc, es, id } = await fresh();
    await es.block(ravi, 'fraud', ADMIN);
    await ok400(svc.act(id, { action: 'accept', engineer_id: ravi }, ADMIN), 409, /blocked/);
  });
  await test('assign: name, phone and ID are copied from the register; reassign works', async () => {
    const { svc, id, store } = await fresh();
    let t = await svc.act(id, { action: 'accept', engineer_id: ravi, engineer_name: 'IGNORED' }, ADMIN);
    assert.strictEqual(t.engineer_name, 'Ravi'); assert.strictEqual(t.engineer_phone, '9876543210'); assert.strictEqual(t.engineer_id, ravi);
    t = await svc.act(id, { action: 'reassign', engineer_id: amit, note: 'Ravi stuck in traffic' }, ADMIN);
    assert.strictEqual(t.engineer_name, 'Amit'); assert.strictEqual(t.status, 'accepted');
    assert.strictEqual(store.events[store.events.length - 1].meta.engineer_code, 'ENG-1002');
  });
  await test('detail offers registered engineers: matching area first, others after', async () => {
    const { svc, id } = await fresh();
    const d = await svc.detail(id);
    assert.deepStrictEqual(d.candidates.recommended.map(x => x.name), ['Ravi']);
    assert.deepStrictEqual(d.candidates.others.map(x => x.name), ['Amit']);
  });
  await test('no engineer covers the site: admin alerted at once, cleared once one is registered', async () => {
    const c = clock('2026-10-13T06:00:00Z');
    const store = memStore(customers);
    const es = E.createEngineerService(store, { now: c.now });
    const svc = T.createTicketService(store, { now: c.now });
    await es.register({ name: 'Far Away', phone: '9811100000', pincode: '500001', id_proof_type: 'driving_licence', id_proof_ref: 'DL-FAR-1' }, ADMIN);
    const t = await svc.create({ customer_id: CUST, description: 'no water' }, ADMIN);
    assert.strictEqual(t.attention, 'no_engineer_in_area');
    assert.strictEqual(t.attention_severity, 'critical');
    assert.strictEqual((await svc.summary()).needs_attention, 1);
    await es.register({ name: 'Local Man', phone: '9811100001', pincode: '122001', id_proof_type: 'driving_licence', id_proof_ref: 'DL-LOCAL-1' }, ADMIN);
    assert.strictEqual((await svc.list('active'))[0].attention, null);
    const far = (await es.list('all')).find(e => e.name === 'Far Away');
    const done = await svc.act(t.id, { action: 'accept', engineer_id: far.id }, ADMIN);   // admin may appoint anyone registered
    assert.strictEqual(done.engineer_name, 'Far Away');
  });

  // ── HTTP layer ──
  await test('HTTP: create, list, detail, action; bad id and bad action return clean errors', async () => {
    const store = memStore(customers);
    const hc = clock('2026-10-13T06:00:00Z');
    const svc = T.createTicketService(store, { now: hc.now });
    const esvc = E.createEngineerService(store, { now: hc.now });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.admin = ADMIN; next(); });
    app.use('/admin/tickets', T.createTicketsRouter(svc));
    app.use('/admin/engineers', E.createEngineersRouter(esvc));
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
      assert.strictEqual((await post('/' + id + '/action', { action: 'accept', engineer_name: 'Typed Name' })).s, 400, 'a typed name must be refused');
      const reg = await fetch(base.replace('tickets', 'engineers'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Ravi', phone: '98765 43210', pincode: '122001', id_proof_type: 'driving_licence', id_proof_ref: 'DL-1111' }) }).then(r => r.json());
      assert.strictEqual(reg.engineer.engineer_code, 'ENG-1001');
      assert.strictEqual((await post('/' + id + '/action', { action: 'accept', engineer_id: reg.engineer.id })).s, 200);
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
