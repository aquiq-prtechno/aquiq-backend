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

function world({ enabled = true, email = 'owner@saffron.test', fail = false, copyTo = null } = {}) {
  const c = clock('2026-10-16T06:00:00Z');
  const store = memStore(customers);
  store.getReportByTicket = async () => null;
  store.getCustomerEmail = async () => email;
  const sent = [];
  const mailer = { enabled, copyTo, send: async (m) => { if (fail) throw new Error('smtp down'); sent.push(m); } };
  const mail = M.createCustomerMailer(store, mailer, { log: { error() {} } });
  const ts = T.createTicketService(store, { now: c.now, mail });
  const es = E.createEngineerService(store, { now: c.now, auth: fakeAccounts() });
  const cs = C.createCustomerService(store, ts, { now: c.now });
  return { c, store, ts, es, cs, sent };
}
const ASK = { store_id: CUST, phone: '9999900000', issue_category: 'Low or no water flow', description: 'No water' };

(async () => {
  await test('care team is in CC on the customer email; with no customer email the team still gets it', async () => {
    const w = world({ copyTo: 'team@aquiq.test' });
    await w.cs.request(ASK); await tick();
    assert.strictEqual(w.sent.length, 1);
    assert.strictEqual(w.sent[0].to, 'owner@saffron.test'); assert.strictEqual(w.sent[0].cc, 'team@aquiq.test');
    const n = world({ copyTo: 'team@aquiq.test', email: null });
    await n.cs.request(ASK); await tick();
    assert.strictEqual(n.sent.length, 1); assert.strictEqual(n.sent[0].to, 'team@aquiq.test'); assert.match(n.sent[0].subject, /no email/);
  });
  await test('every service email uses the AQUIQ layout with its own wording, text and html', async () => {
    const sent = [];
    const store = { getCustomerEmail: async () => 'c@x.test' };
    const mail = M.createCustomerMailer(store, { enabled: true, copyTo: 'care@x.test', send: async (m) => sent.push(m) });
    const t = { ticket_no: 'PMR2611790131016', contact_person: 'Anuj Thakur', customer_id: 'c1', issue_category: 'Water leakage', urgency: 'urgent', created_at: '2026-10-16T06:00:00Z', engineer_name: 'Ravi', eta_at: '2026-10-16T07:00:00Z' };
    await mail.created(t); await mail.delayed(t); await mail.reopened(t); await mail.cancelled(t);
    assert.strictEqual(sent.length, 4);
    for (const m of sent) {
      assert.match(m.text, /^AQUIQ\n\nTicket ID: PMR2611790131016/); assert.match(m.text, /Hey Anuj Thakur,/);
      assert.match(m.text, /Team: AQUIQ-SERVICE DESK/); assert.match(m.text, /Regards,\nAQUIQ SERVICE-DESK/); assert.match(m.text, /system-generated notification/);
      assert.match(m.html, /<b>Ticket ID:<\/b> PMR2611790131016/); assert.ok(!/WMS|PR TECHNO/.test(m.text + m.html));
    }
    assert.match(sent[0].text, /received your service request/); assert.match(sent[0].text, /Problem: Water leakage \(urgent\)/);
    assert.match(sent[1].text, /running late/); assert.match(sent[1].text, /Promised by:/);
    assert.match(sent[2].text, /reopened/); assert.match(sent[3].subject, /cancelled/); assert.match(sent[3].text, /no engineer will visit/);
  });
  await test('relay mode: the message goes to the relay over HTTPS with the secret and a base64 attachment', async () => {
    const R = require('../reports');
    const calls = [];
    const http = { post: async (url, body, opts) => { calls.push({ url, body, opts }); return {}; } };
    const m = R.createMailer({ MAIL_PROVIDER: 'relay', MAIL_RELAY_URL: 'https://x.vercel.app/api/send-mail', MAIL_RELAY_SECRET: 's3cret' }, http);
    assert.strictEqual(m.enabled, true); assert.strictEqual(m.provider, 'relay');
    await m.send({ to: 'a@b.co', cc: 'c@d.co', subject: 'S', text: 'T', attachments: [{ filename: 'r.pdf', content: Buffer.from('%PDF') }] });
    assert.strictEqual(calls[0].url, 'https://x.vercel.app/api/send-mail');
    assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer s3cret');
    assert.deepStrictEqual(calls[0].body.to, ['a@b.co']); assert.strictEqual(calls[0].body.attachments[0].content, Buffer.from('%PDF').toString('base64'));
    assert.strictEqual(R.createMailer({ MAIL_PROVIDER: 'relay', MAIL_RELAY_URL: 'u' }, http).enabled, false, 'needs both url and secret');
  });

  await test('the customer gets emails for request, delay and reopen only, to the registered account email', async () => {
    const w = world();
    const eng = await w.es.register({ name: 'Ravi Kumar', phone: '9876543210', pincode: '122001', id_proof_type: 'pan', id_proof_ref: 'ABCDE1234F' }, ADMIN);
    const o = await w.cs.request(ASK); await tick();
    assert.match(w.sent[0].subject, /received/); assert.match(w.sent[0].text, /PMR/);
    assert.strictEqual(w.sent[0].to, 'owner@saffron.test');
    await w.ts.act(o.ticket.id, { action: 'accept', engineer_id: eng.id, eta_minutes: 30 }, ADMIN); await tick();
    assert.strictEqual(w.sent.length, 1, 'no email when an engineer is assigned');
    const e = await w.store.getEngineer(eng.id);
    await w.ts.engineerAct(e, o.ticket.id, { action: 'arrive', lat: 28.45, lng: 77.02 });
    await w.ts.engineerAct(e, o.ticket.id, { action: 'work_done', checklist: ALL_TICKS }); await tick();
    assert.strictEqual(w.sent.length, 1, 'no email when the work is finished');
    await w.ts.act(o.ticket.id, { action: 'not_satisfied', note: 'still leaking' }, ADMIN); await tick();
    assert.match(w.sent[1].subject, /reopened/);
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
