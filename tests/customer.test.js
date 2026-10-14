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

  for (const [s, n] of results) console.log(`${s}  ${n}`);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})();
