'use strict';
// Run:  node tests/push.test.js
const assert = require('assert');
const T = require('../tickets');
const E = require('../engineers');
const P = require('../push');
const { memStore, clock, CUST, customers, ADMIN, fakeAccounts } = require('./helpers');

let passed = 0; const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + '  ->  ' + e.message]); }
}
const tick = () => new Promise(r => setImmediate(r));

function world(sendImpl) {
  const c = clock('2026-10-14T06:00:00Z');
  const store = memStore(customers);
  const sent = [];
  const send = sendImpl || (async (m) => { sent.push(...m); return m.map(() => ({ status: 'ok' })); });
  const push = P.createPushService(store, { send, log: { error() {} } });
  const ts = T.createTicketService(store, { now: c.now, push });
  const es = E.createEngineerService(store, { now: c.now, auth: fakeAccounts() });
  return { store, ts, es, sent, push };
}
const reg = (es, name, o = {}) => es.register({ name, phone: o.phone || '9876543210', pincode: o.pincode || '122001', id_proof_type: 'pan', id_proof_ref: o.ref || 'ABCDE1234F' }, ADMIN);
const TOKEN = (n) => `ExponentPushToken[token-number-${n}]`;

(async () => {
  await test('a new complaint pushes to every covering engineer and nobody else', async () => {
    const { store, ts, es, sent } = world();
    const near = await reg(es, 'Ravi');
    const far = await reg(es, 'Amit', { phone: '9811100000', pincode: '500001', ref: 'FGHIJ5678K' });
    await store.upsertDevice({ token: TOKEN(1), engineer_id: near.id, platform: 'android' });
    await store.upsertDevice({ token: TOKEN(2), engineer_id: far.id, platform: 'android' });
    const t = await ts.create({ customer_id: CUST, description: 'No water', issue_category: 'Low or no water flow', urgency: 'urgent' }, ADMIN);
    await tick();
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].to, TOKEN(1));
    assert.match(sent[0].title, /URGENT/);
    assert.strictEqual(sent[0].sound, 'default');
    assert.strictEqual(sent[0].channelId, 'complaints');
    assert.strictEqual(sent[0].data.ticket_no, t.ticket_no);
  });

  await test('the notification never carries the customer name, phone or address', async () => {
    const { store, ts, es, sent } = world();
    const e = await reg(es, 'Ravi');
    await store.upsertDevice({ token: TOKEN(1), engineer_id: e.id });
    await ts.create({ customer_id: CUST, description: 'No water', issue_category: 'Other' }, ADMIN);
    await tick();
    const blob = JSON.stringify(sent);
    for (const bad of ['Hotel Saffron', '9999900000', 'Sector 14']) assert.ok(!blob.includes(bad), `leaked ${bad}`);
  });

  await test('blocked engineers get nothing', async () => {
    const { store, ts, es, sent } = world();
    const e = await reg(es, 'Ravi');
    await store.upsertDevice({ token: TOKEN(1), engineer_id: e.id });
    await es.block(e.id, 'cheated', ADMIN);
    await ts.create({ customer_id: CUST, description: 'No water', issue_category: 'Other' }, ADMIN);
    await tick();
    assert.strictEqual(sent.length, 0);
  });

  await test('assigning by admin pushes to that engineer; reopening pushes to the same engineer', async () => {
    const { store, ts, es, sent } = world();
    const e = await reg(es, 'Ravi');
    await store.upsertDevice({ token: TOKEN(1), engineer_id: e.id });
    const t = await ts.create({ customer_id: CUST, description: 'No water', issue_category: 'Other' }, ADMIN);
    await tick(); sent.length = 0;
    await ts.act(t.id, { action: 'accept', engineer_id: e.id, eta_minutes: 30 }, ADMIN);
    await tick();
    assert.strictEqual(sent.length, 1); assert.match(sent[0].title, /assigned/);
    const eng = await store.getEngineer(e.id);
    await ts.engineerAct(eng, t.id, { action: 'arrive' });
    await ts.engineerAct(eng, t.id, { action: 'work_done' });
    sent.length = 0;
    await ts.act(t.id, { action: 'not_satisfied', note: 'still leaking' }, ADMIN);
    await tick();
    assert.strictEqual(sent.length, 1); assert.match(sent[0].title, /not satisfied/);
  });

  await test('a failing push service never breaks creating a ticket; dead phone tokens are removed', async () => {
    const boom = world(async () => { throw new Error('expo down'); });
    const e = await reg(boom.es, 'Ravi');
    await boom.store.upsertDevice({ token: TOKEN(1), engineer_id: e.id });
    const t = await boom.ts.create({ customer_id: CUST, description: 'No water', issue_category: 'Other' }, ADMIN);
    assert.ok(t.ticket_no);

    const dead = world(async (m) => m.map(() => ({ status: 'error', details: { error: 'DeviceNotRegistered' } })));
    const e2 = await reg(dead.es, 'Ravi');
    await dead.store.upsertDevice({ token: TOKEN(9), engineer_id: e2.id });
    await dead.ts.create({ customer_id: CUST, description: 'No water', issue_category: 'Other' }, ADMIN);
    await tick(); await tick();
    assert.strictEqual(dead.store.devices.length, 0);
  });

  for (const [s, n] of results) console.log(`${s}  ${n}`);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})();
