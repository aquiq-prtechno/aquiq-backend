'use strict';
// Run:  node tests/customer.test.js
const assert = require('assert');
const T = require('../tickets');
const E = require('../engineers');
const C = require('../customerApi');
const { memStore, clock, ok400, CUST, customers, ADMIN, fakeAccounts } = require('./helpers');

let passed = 0; const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + '  ->  ' + e.message]); }
}
function world() {
  const c = clock('2026-10-14T06:00:00Z');
  const store = memStore(customers);
  store.getReportByTicket = async () => null;
  const ts = T.createTicketService(store, { now: c.now });
  const es = E.createEngineerService(store, { now: c.now, auth: fakeAccounts() });
  const cs = C.createCustomerService(store, ts, { now: c.now });
  return { c, store, ts, es, cs };
}
const ASK = { store_id: CUST, phone: '99999 00000', issue_category: 'Low or no water flow', description: 'No water since morning' };

(async () => {
  await test('a customer request becomes a ticket that nearby engineers see as a new complaint', async () => {
    const { cs, es, ts, store } = world();
    const eng = await es.register({ name: 'Ravi', phone: '9876543210', pincode: '122001', id_proof_type: 'pan', id_proof_ref: 'ABCDE1234F' }, ADMIN);
    const out = await cs.request(ASK);
    assert.strictEqual(out.already_open, false);
    assert.match(out.ticket.ticket_no, /^PMR\d{2}117\d+\d{4}$/);
    assert.strictEqual(store.tickets[0].source, 'customer_app');
    const offers = (await ts.engineerJobs(await store.getEngineer(eng.id))).offers;
    assert.strictEqual(offers.length, 1);
    assert.strictEqual(offers[0].ticket_no, out.ticket.ticket_no);
    assert.ok((await store.listEvents(store.tickets[0].id))[0].actor.startsWith('customer:'));
  });

  await test('a second tap returns the open request instead of creating another', async () => {
    const { cs, store } = world();
    const a = await cs.request(ASK);
    const b = await cs.request(ASK);
    assert.strictEqual(b.already_open, true);
    assert.strictEqual(b.ticket.ticket_no, a.ticket.ticket_no);
    assert.strictEqual(store.tickets.length, 1);
  });

  await test('wrong store or wrong mobile is refused with one generic message', async () => {
    const { cs, store } = world();
    await ok400(cs.request({ ...ASK, phone: '9000000000' }), 401, /could not verify/);
    await ok400(cs.request({ ...ASK, store_id: '22222222-2222-4222-8222-222222222222' }), 401, /could not verify/);
    await ok400(cs.request({ ...ASK, store_id: 'nope' }), 401);
    assert.strictEqual(store.tickets.length, 0);
  });

  await test('needs a known problem type and a short description', async () => {
    const { cs } = world();
    await ok400(cs.request({ ...ASK, issue_category: 'Hacked' }), 400, /what the problem is/);
    await ok400(cs.request({ ...ASK, description: ' ' }), 400, /describe/i);
  });

  await test('after the job is closed a new request is allowed; no more than 5 in a day', async () => {
    const { cs, ts, store } = world();
    for (let i = 0; i < 5; i++) {
      const o = await cs.request(ASK);
      await ts.act(o.ticket.id, { action: 'cancel', note: 'test' }, ADMIN);
    }
    await ok400(cs.request(ASK), 429, /limit/);
    assert.strictEqual(store.tickets.length, 5);
  });

  await test('status list shows progress and engineer name, nothing personal', async () => {
    const { cs, es, ts, store } = world();
    const eng = await es.register({ name: 'Ravi', phone: '9876543210', pincode: '122001', id_proof_type: 'pan', id_proof_ref: 'ABCDE1234F' }, ADMIN);
    const o = await cs.request(ASK);
    await ts.act(o.ticket.id, { action: 'accept', engineer_id: eng.id, eta_minutes: 40 }, ADMIN);
    const l = await cs.list(ASK);
    assert.strictEqual(l.tickets[0].status, 'accepted');
    assert.strictEqual(l.tickets[0].engineer_name, 'Ravi');
    assert.ok(!JSON.stringify(l).includes('9876543210'));
    assert.ok(l.categories.includes('Pump not running / noisy'));
  });

  async function toWorkDone(w) {
    const eng = await w.es.register({ name: 'Ravi', phone: '9876543210', pincode: '122001', id_proof_type: 'pan', id_proof_ref: 'ABCDE1234F' }, ADMIN);
    const o = await w.cs.request(ASK);
    await w.ts.act(o.ticket.id, { action: 'accept', engineer_id: eng.id, eta_minutes: 30 }, ADMIN);
    const e = await w.store.getEngineer(eng.id);
    await w.ts.engineerAct(e, o.ticket.id, { action: 'arrive' });
    await w.ts.engineerAct(e, o.ticket.id, { action: 'work_done' });
    return { id: o.ticket.id, e };
  }

  await test('the customer can approve finished work; then the engineer can file the report', async () => {
    const w = world(); const { id } = await toWorkDone(w);
    const l = await w.cs.list(ASK);
    assert.strictEqual(l.tickets[0].can_respond, true);
    const out = await w.cs.approve({ ...ASK, ticket_id: id });
    assert.strictEqual(out.ticket.status, 'approved');
    assert.strictEqual((await w.store.getTicket(id)).customer_response, 'approved');
    await ok400(w.cs.approve({ ...ASK, ticket_id: id }), 409, /not waiting/);
  });

  await test('"not satisfied" needs a reason and reopens the job', async () => {
    const w = world(); const { id } = await toWorkDone(w);
    await ok400(w.cs.notSatisfied({ ...ASK, ticket_id: id, reason: ' ' }), 400, /still wrong/);
    const out = await w.cs.notSatisfied({ ...ASK, ticket_id: id, reason: 'Still leaking at the joint' });
    assert.strictEqual(out.ticket.status, 'reopened');
    assert.strictEqual((await w.store.getTicket(id)).customer_reason, 'Still leaking at the joint');
  });

  await test('a customer cannot approve someone else’s request or one that is not finished', async () => {
    const w = world(); const { id } = await toWorkDone(w);
    const other = '33333333-3333-4333-8333-333333333333';
    w.store.tickets.find(t => t.id === id).customer_id = other;
    await ok400(w.cs.approve({ ...ASK, ticket_id: id }), 404, /could not find/);
    await ok400(w.cs.approve({ ...ASK, ticket_id: 'bad' }), 404);
    const w2 = world(); const o = await w2.cs.request(ASK);
    await ok400(w2.cs.approve({ ...ASK, ticket_id: o.ticket.id }), 409, /not waiting/);
    await ok400(w2.cs.approve({ ...ASK, phone: '9000000000', ticket_id: o.ticket.id }), 401);
  });

  await test('the customer gets a link to the finished service report only when it exists', async () => {
    const w = world(); const { id } = await toWorkDone(w);
    await ok400(w.cs.report({ ...ASK, ticket_id: id }), 404, /not ready/);
    w.store.getReportByTicket = async () => ({ report_no: 'FSR-X', pdf_path: `${id}/FSR-X.pdf` });
    const r = await w.cs.report({ ...ASK, ticket_id: id });
    assert.match(r.pdf_url, /service-reports/);
    assert.strictEqual(r.report_no, 'FSR-X');
  });

  await test('customer sees how far the engineer is and roughly how long, only while on the way', async () => {
    const w = world();
    const eng = await w.es.register({ name: 'Ravi', phone: '9876543210', pincode: '122001', id_proof_type: 'pan', id_proof_ref: 'ABCDE1234F' }, ADMIN);
    const o = await w.cs.request(ASK);
    await w.ts.act(o.ticket.id, { action: 'accept', engineer_id: eng.id, eta_minutes: 30 }, ADMIN);
    const e = await w.store.getEngineer(eng.id);
    assert.strictEqual((await w.cs.list(ASK)).tickets[0].engineer_location, null);       // no position yet
    await ok400(w.ts.engineerLocation(e, o.ticket.id, { lat: 1, lng: 1 }), 400, /not valid/);
    await w.ts.engineerLocation(e, o.ticket.id, { lat: 28.50, lng: 77.10 });             // ~10 km from the site
    const loc = (await w.cs.list(ASK)).tickets[0].engineer_location;
    assert.ok(loc.distance_km > 5 && loc.distance_km < 30, `distance ${loc.distance_km}`);
    assert.ok(loc.eta_minutes >= 5 && loc.eta_minutes <= 90);
    assert.strictEqual(typeof loc.site.lat, 'number');
    w.c.add(15 * 60);                                                                     // stale after 10 minutes
    assert.strictEqual((await w.cs.list(ASK)).tickets[0].engineer_location, null);
    await w.ts.engineerAct(e, o.ticket.id, { action: 'arrive' });
    await w.ts.engineerLocation(e, o.ticket.id, { lat: 28.45, lng: 77.02 });
    assert.strictEqual((await w.cs.list(ASK)).tickets[0].engineer_location, null);        // arrived: tracking stops
  });

  await test('engineer history lists finished jobs only, newest first', async () => {
    const w = world();
    const eng = await w.es.register({ name: 'Ravi', phone: '9876543210', pincode: '122001', id_proof_type: 'pan', id_proof_ref: 'ABCDE1234F' }, ADMIN);
    const e = await w.store.getEngineer(eng.id);
    const o = await w.cs.request(ASK);
    await w.ts.act(o.ticket.id, { action: 'accept', engineer_id: eng.id }, ADMIN);
    assert.strictEqual((await w.ts.engineerHistory(e)).length, 0);
    await w.ts.engineerAct(e, o.ticket.id, { action: 'arrive' });
    await w.ts.engineerAct(e, o.ticket.id, { action: 'work_done' });
    await w.ts.act(o.ticket.id, { action: 'approve_on_behalf', note: 'ok' }, ADMIN);
    await w.ts.act(o.ticket.id, { action: 'close', note: 'done' }, ADMIN);
    const h = await w.ts.engineerHistory(e);
    assert.strictEqual(h.length, 1);
    assert.strictEqual(h[0].report_no, `FSR-${h[0].ticket_no}`);
  });

  for (const [s, n] of results) console.log(`${s}  ${n}`);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})();
