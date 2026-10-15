'use strict';
// Run:  node tests/ask.test.js
const assert = require('assert');
const T = require('../tickets');
const E = require('../engineers');
const C = require('../customerApi');
const A = require('../askBrain');
const K = require('../askKnowledge');
const { memStore, clock, ok400, CUST, customers, ADMIN, fakeAccounts, ALL_TICKS } = require('./helpers');

let passed = 0; const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + '  ->  ' + e.message]); }
}
function world(env = {}, http) {
  const c = clock('2026-10-16T06:00:00Z');
  const store = memStore(customers);
  store.getReportByTicket = async () => null;
  const ts = T.createTicketService(store, { now: c.now });
  const es = E.createEngineerService(store, { now: c.now, auth: fakeAccounts() });
  const ask = A.createAskService({ now: c.now, env, http, log: { error() {} } });
  const cs = C.createCustomerService(store, ts, { now: c.now, ask });
  return { c, store, ts, es, cs };
}
const ID = { store_id: CUST, phone: '9999900000' };
async function oneFinishedJob(w) {
  const eng = await w.es.register({ name: 'Ravi Kumar', phone: '9876543210', pincode: '122001', id_proof_type: 'pan', id_proof_ref: 'ABCDE1234F' }, ADMIN);
  const o = await w.cs.request({ ...ID, issue_category: 'Low or no water flow', description: 'No water' });
  await w.ts.act(o.ticket.id, { action: 'accept', engineer_id: eng.id }, ADMIN);
  const e = await w.store.getEngineer(eng.id);
  await w.ts.engineerAct(e, o.ticket.id, { action: 'arrive', lat: 28.45, lng: 77.02 });
  await w.ts.engineerAct(e, o.ticket.id, { action: 'work_done', checklist: ALL_TICKS });
  await w.ts.act(o.ticket.id, { action: 'approve_on_behalf', note: 'ok' }, ADMIN);
  await w.ts.act(o.ticket.id, { action: 'close', note: 'done' }, ADMIN);
}

(async () => {
  await test('"who did the last service" is answered from the customer\'s own visit log', async () => {
    const w = world(); await oneFinishedJob(w);
    const r = await w.cs.ask({ ...ID, question: 'Who did my last service?' });
    assert.match(r.answer, /Ravi Kumar/);
    assert.match(r.answer, /Low or no water flow/);
    assert.strictEqual(r.mode, 'rules');
  });

  await test('with no visits it says so', async () => {
    const w = world();
    const r = await w.cs.ask({ ...ID, question: 'when was the last service' });
    assert.match(r.answer, /no visits/i);
  });

  await test('rules, retention and updates come from the knowledge base', async () => {
    const w = world();
    assert.match((await w.cs.ask({ ...ID, question: 'What rules do engineers follow? Can they take cash?' })).answer, /never take cash/i);
    assert.match((await w.cs.ask({ ...ID, question: 'how long are photos kept' })).answer, /12 months/);
    assert.match((await w.cs.ask({ ...ID, question: 'what is new in the app' })).answer, /Visit Log/);
    assert.match((await w.cs.ask({ ...ID, question: 'how do I download excel' })).answer, /Download Excel/);
  });

  await test('unknown questions get a polite pointer to support', async () => {
    const w = world();
    const r = await w.cs.ask({ ...ID, question: 'what is the capital of france' });
    assert.match(r.answer, /careprtech@hotmail.com/);
  });

  await test('with an API key the AI model is used, with the visit log and knowledge in the prompt', async () => {
    let sent = null;
    const http = { post: async (url, body, opts) => { sent = { url, body, opts }; return { data: { content: [{ type: 'text', text: 'Your last service was by Ravi Kumar.' }] } }; } };
    const w = world({ ANTHROPIC_API_KEY: 'test-key' }, http); await oneFinishedJob(w);
    const r = await w.cs.ask({ ...ID, question: 'who serviced last?' });
    assert.strictEqual(r.mode, 'ai');
    assert.match(sent.body.system, /Engineer rules|Rules AQUIQ engineers follow/);
    assert.match(sent.body.messages.slice(-1)[0].content, /Ravi Kumar/);
    assert.strictEqual(sent.opts.headers['x-api-key'], 'test-key');
    assert.ok(!JSON.stringify(sent).includes('9876543210'), 'engineer phone must never reach the model');
  });

  await test('if the AI model fails, the knowledge base still answers', async () => {
    const http = { post: async () => { throw new Error('model down'); } };
    const w = world({ ANTHROPIC_API_KEY: 'k' }, http);
    const r = await w.cs.ask({ ...ID, question: 'what rules do engineers follow' });
    assert.strictEqual(r.mode, 'rules');
    assert.match(r.answer, /ID-verified/);
  });

  await test('wrong store/mobile is refused; daily limit applies', async () => {
    const w = world();
    await ok400(w.cs.ask({ ...ID, phone: '9000000000', question: 'hello there' }), 401);
    await ok400(w.cs.ask({ ...ID, question: ' ' }), 400);
    let last;
    for (let i = 0; i < A.DAILY_LIMIT + 1; i++) last = await w.cs.ask({ ...ID, question: 'what is aquiq' });
    assert.strictEqual(last.mode, 'limit');
  });

  await test('knowledge search finds the right section', async () => {
    assert.strictEqual(K.search('how do I request a service').id, 'request');
    assert.strictEqual(K.search('how can I contact support').id, 'support');
  });

  for (const [s, n] of results) console.log(`${s}  ${n}`);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})();
