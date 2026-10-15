'use strict';
// Run:  node tests/fieldrules.test.js
// Arrival check, checklist, parts, duty switch, SOP acceptance, repeat flag, scorecard, rating.
const assert = require('assert');
const T = require('../tickets');
const E = require('../engineers');
const R = require('../reports');
const C = require('../customerApi');
const { memStore, clock, ok400, CUST, customers, ADMIN, fakeAccounts, ALL_TICKS } = require('./helpers');

let passed = 0; const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + '  ->  ' + e.message + (e.stack ? '\n' + e.stack.split('\n')[1] : '')]); }
}
const FORM = { overall_status: 'Completed', capacity: '100/150 LPH', tds_status: 'NO ISSUE (USER)', load: 'No Fluctuation' };
const PHOTO = (id) => `jobs/${id}/00000001-0000-4000-8000-000000000000.jpg`;

function world() {
  const c = clock('2026-10-15T06:00:00Z');
  const store = memStore(customers);
  const rows = [];
  store.getReportByTicket = async (id) => JSON.parse(JSON.stringify(rows.find(r => r.ticket_id === id) || null));
  store.insertReport = async (row) => { const r = { id: `r${rows.length + 1}`, ...JSON.parse(JSON.stringify(row)) }; rows.push(r); return r; };
  store.updateReport = async (id, patch) => { Object.assign(rows.find(r => r.id === id), patch); };
  store.deleteReport = async () => {};
  store.uploadObject = async () => {};
  store.getCustomerEmail = async () => null;
  const es = E.createEngineerService(store, { now: c.now, auth: fakeAccounts() });
  const ts = T.createTicketService(store, { now: c.now });
  const rs = R.createReportService(store, ts, { now: c.now });
  const cs = C.createCustomerService(store, ts, { now: c.now, reports: rs });
  return { c, store, es, ts, rs, cs, rows };
}
const ASK = { store_id: CUST, phone: '9999900000', issue_category: 'Low or no water flow', description: 'No water' };
async function assigned(w, ph = '9876543210') {
  const eng = await w.es.register({ name: 'Ravi', phone: ph, pincode: '122001', id_proof_type: 'pan', id_proof_ref: 'ABCDE1234F' }, ADMIN);
  const o = await w.cs.request(ASK);
  await w.ts.act(o.ticket.id, { action: 'accept', engineer_id: eng.id }, ADMIN);
  return { id: o.ticket.id, e: await w.store.getEngineer(eng.id), eng };
}

(async () => {
  await test('"Arrived" only counts at the site (within 500 m)', async () => {
    const w = world(); const { id, e } = await assigned(w);
    await ok400(w.ts.engineerAct(e, id, { action: 'arrive', lat: 28.55, lng: 77.15 }), 409, /from the site/);
    await ok400(w.ts.engineerAct(e, id, { action: 'arrive' }), 409, /turn on your location/i);
    const j = await w.ts.engineerAct(e, id, { action: 'arrive', lat: 28.4503, lng: 77.0203 });
    assert.strictEqual(j.status, 'arrived');
    const ev = (await w.store.listEvents(id)).find(x => x.action === 'arrive');
    assert.match(ev.note, /at site/);
  });

  await test('without a position the engineer may arrive only by giving a reason, which is recorded', async () => {
    const w = world(); const { id, e } = await assigned(w);
    await ok400(w.ts.engineerAct(e, id, { action: 'arrive', no_gps_reason: 'because' }), 409);
    const j = await w.ts.engineerAct(e, id, { action: 'arrive', no_gps_reason: 'gps_off' });
    assert.strictEqual(j.status, 'arrived');
    const ev = (await w.store.listEvents(id)).find(x => x.action === 'arrive');
    assert.match(ev.note, /without a location check/);
  });

  await test('work done needs every checklist item ticked and records it', async () => {
    const w = world(); const { id, e } = await assigned(w);
    await w.ts.engineerAct(e, id, { action: 'arrive', lat: 28.45, lng: 77.02 });
    await ok400(w.ts.engineerAct(e, id, { action: 'work_done' }), 400, /checklist/);
    await ok400(w.ts.engineerAct(e, id, { action: 'work_done', checklist: { ...ALL_TICKS, leaks: false } }), 400, /checklist/);
    const j = await w.ts.engineerAct(e, id, { action: 'work_done', checklist: ALL_TICKS });
    assert.strictEqual(j.status, 'work_done');
    assert.ok((await w.store.listEvents(id)).some(x => x.action === 'checklist'));
  });

  await test('spare parts and the checklist go into the report', async () => {
    const w = world(); const { id, e } = await assigned(w);
    await w.ts.engineerAct(e, id, { action: 'arrive', lat: 28.45, lng: 77.02 });
    await w.ts.engineerAct(e, id, { action: 'work_done', checklist: ALL_TICKS });
    await w.ts.act(id, { action: 'approve_on_behalf', note: 'ok' }, ADMIN);
    const p = PHOTO(id); w.store.files.add(p);
    await w.ts.engineerAddPhoto(e, id, { path: p, kind: 'other', mime: 'image/jpeg' });
    await ok400(w.rs.submit(e, id, { ...FORM, parts: [{ name: 'Rocket engine', qty: 1 }] }), 400, /spare part/i);
    await ok400(w.rs.submit(e, id, { ...FORM, parts: [{ name: 'RO membrane', qty: 0 }] }), 400, /quantity/i);
    await w.rs.submit(e, id, { ...FORM, parts: [{ name: 'RO membrane', qty: 1 }, { name: 'Sediment filter', qty: 2 }] });
    const r = w.rows[0];
    assert.deepStrictEqual(r.data.parts, [{ name: 'RO membrane', qty: 1 }, { name: 'Sediment filter', qty: 2 }]);
    assert.strictEqual(r.data.checklist_done, 5);
  });

  await test('off duty: no offers and no push; back on duty: offers return', async () => {
    const w = world();
    const eng = await w.es.register({ name: 'Ravi', phone: '9876543210', pincode: '122001', id_proof_type: 'pan', id_proof_ref: 'ABCDE1234F' }, ADMIN);
    await w.cs.request(ASK);
    let e = await w.store.getEngineer(eng.id);
    assert.strictEqual((await w.ts.engineerJobs(e)).offers.length, 1);
    await w.store.updateEngineer(eng.id, { on_duty: false });
    e = await w.store.getEngineer(eng.id);
    assert.strictEqual((await w.ts.engineerJobs(e)).offers.length, 0);
  });

  await test('a repeat complaint within 30 days is flagged to the engineer', async () => {
    const w = world(); const { id, e } = await assigned(w);
    await w.ts.engineerAct(e, id, { action: 'arrive', lat: 28.45, lng: 77.02 });
    await w.ts.engineerAct(e, id, { action: 'work_done', checklist: ALL_TICKS });
    await w.ts.act(id, { action: 'approve_on_behalf', note: 'ok' }, ADMIN);
    await w.ts.act(id, { action: 'close', note: 'done' }, ADMIN);
    w.c.add(10 * 86400);
    await w.cs.request(ASK);
    const offers = (await w.ts.engineerJobs(e)).offers;
    assert.strictEqual(offers[0].repeat_within_30d, true);
  });

  await test('the customer rates a finished service once; the engineer scorecard shows it', async () => {
    const w = world(); const { id, e, eng } = await assigned(w);
    await w.ts.engineerAct(e, id, { action: 'arrive', lat: 28.45, lng: 77.02 });
    await w.ts.engineerAct(e, id, { action: 'work_done', checklist: ALL_TICKS });
    await w.ts.act(id, { action: 'approve_on_behalf', note: 'ok' }, ADMIN);
    const p = PHOTO(id); w.store.files.add(p);
    await w.ts.engineerAddPhoto(e, id, { path: p, kind: 'other', mime: 'image/jpeg' });
    await w.rs.submit(e, id, FORM);
    await ok400(w.cs.rate({ ...ASK, ticket_id: id, rating: 9 }), 400, /1 to 5/);
    await w.cs.rate({ ...ASK, ticket_id: id, rating: 4, comment: 'Good and quick' });
    await ok400(w.cs.rate({ ...ASK, ticket_id: id, rating: 5 }), 409, /already/);
    const l = await w.cs.list(ASK);
    assert.strictEqual(l.tickets[0].rating, 4);
    w.store.ratingRows = w.rows.map(r => ({ rating: r.rating, approval_mode: r.approval_mode }));
    const sc = await w.ts.engineerScorecard(eng.id);
    assert.strictEqual(sc.jobs_done, 1);
    assert.strictEqual(sc.avg_rating, 4);
    assert.strictEqual(sc.ratings_count, 1);
  });

  for (const [s, n] of results) console.log(`${s}  ${n}`);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})();
