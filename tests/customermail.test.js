'use strict';
// Run:  node tests/customermail.test.js
const assert = require('assert');
const T = require('../tickets');
const E = require('../engineers');
const C = require('../customerApi');
const M = require('../customerMail');
const { memStore, clock, CUST, customers, ADMIN, fakeAccounts, ALL_TICKS } = require('./helpers');

let passed = 0; const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + '  ->  ' + e.message]); }
}
const tick = () => new Promise(r => setImmediate(r));

function world({ enabled = true, email = 'owner@saffron.test', fail = false } = {}) {
  const c = clock('2026-10-16T06:00:00Z');
  const store = memStore(customers);
  store.getReportByTicket = async () => null;
  store.getCustomerEmail = async () => email;
  const sent = [];
  const mailer = { enabled, send: async (m) => { if (fail) throw new Error('smtp down'); sent.push(m); } };
  const mail = M.createCustomerMailer(store, mailer, { log: { error() {} } });
  const ts = T.createTicketService(store, { now: c.now, mail });
  const es = E.createEngineerService(store, { now: c.now, auth: fakeAccounts() });
  const cs = C.createCustomerService(store, ts, { now: c.now });
  return { c, store, ts, es, cs, sent };
}
const ASK = { store_id: CUST, phone: '9999900000', issue_category: 'Low or no water flow', description: 'No water' };

(async () => {
  await test('the customer gets an email at each step, to the registered account email', async () => {
    const w = world();
    const eng = await w.es.register({ name: 'Ravi Kumar', phone: '9876543210', pincode: '122001', id_proof_type: 'pan', id_proof_ref: 'ABCDE1234F' }, ADMIN);
    const o = await w.cs.request(ASK); await tick();
    assert.match(w.sent[0].subject, /received/); assert.match(w.sent[0].text, /PMR/);
    assert.strictEqual(w.sent[0].to, 'owner@saffron.test');
    await w.ts.act(o.ticket.id, { action: 'accept', engineer_id: eng.id, eta_minutes: 30 }, ADMIN); await tick();
    assert.match(w.sent[1].subject, /Engineer assigned/); assert.match(w.sent[1].text, /Ravi Kumar/);
    const e = await w.store.getEngineer(eng.id);
    await w.ts.engineerAct(e, o.ticket.id, { action: 'arrive', lat: 28.45, lng: 77.02 });
    await w.ts.engineerAct(e, o.ticket.id, { action: 'work_done', checklist: ALL_TICKS }); await tick();
    assert.match(w.sent[2].subject, /please approve/);
    await w.ts.act(o.ticket.id, { action: 'not_satisfied', note: 'still leaking' }, ADMIN); await tick();
    assert.match(w.sent[3].subject, /reopened/);
  });

  await test('a late engineer triggers one "running late" email', async () => {
    const w = world();
    const eng = await w.es.register({ name: 'Ravi Kumar', phone: '9876543210', pincode: '122001', id_proof_type: 'pan', id_proof_ref: 'ABCDE1234F' }, ADMIN);
    const o = await w.cs.request(ASK);
    await w.ts.act(o.ticket.id, { action: 'accept', engineer_id: eng.id, eta_minutes: 20 }, ADMIN); await tick();
    w.sent.length = 0;
    w.c.add(40 * 60);
    await w.ts.runWatcher(); await tick();
    assert.strictEqual(w.sent.length, 1); assert.match(w.sent[0].subject, /Update on your service request/);
    await w.ts.runWatcher(); await tick();
    assert.strictEqual(w.sent.length, 1, 'not repeated');
  });

  await test('no email on file, mail switched off, or mail failing: nothing breaks', async () => {
    for (const opt of [{ email: null }, { enabled: false }, { fail: true }]) {
      const w = world(opt);
      const o = await w.cs.request(ASK); await tick();
      assert.ok(o.ticket.ticket_no);
      assert.strictEqual(w.sent.length, 0);
    }
  });

  for (const [s, n] of results) console.log(`${s}  ${n}`);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})();
