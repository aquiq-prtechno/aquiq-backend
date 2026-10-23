'use strict';
// Run:  node tests/inbound.test.js
const assert = require('assert');
const T = require('../tickets');
const E = require('../engineers');
const I = require('../inbound');
const M = require('../customerMail');
const { memStore, clock, ok400, CUST, customers, ADMIN, fakeAccounts } = require('./helpers');

let passed = 0; const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + '  ->  ' + e.message]); }
}
const tick = () => new Promise(r => setImmediate(r));

function world({ storeEmail = null, uhad = null, uhadStores = [] } = {}) {
  const c = clock('2026-10-23T05:42:34Z');
  const base = memStore(customers);
  const inbound = new Map();
  const sent = [];
  const store = {
    ...base,
    getCustomerEmail: async (id) => (id === CUST ? storeEmail : null),
    async claimInbound(row) { if (inbound.has(row.message_id)) return false; inbound.set(row.message_id, { ...row, received_at: c.now().toISOString() }); return true; },
    async finishInbound(id, patch) { Object.assign(inbound.get(id), patch); },
    async releaseInbound(id) { inbound.delete(id); },
    async countTicketsFromSince(email) { return [...inbound.values()].filter(r => r.from_email === email && ['ticket_created', 'ticket_unverified'].includes(r.outcome)).length; },
    async findStoresByVerifiedEmail(email) { return storeEmail && email === storeEmail ? [customers[CUST]] : []; },
    async findUhadByEmail(email) { return uhad && uhad.email === email ? uhad : null; },
    async listStoresOfUhad() { return uhadStores; },
  };
  const mailer = { enabled: true, copyTo: 'team@aq.test', send: async (m) => sent.push(m) };
  const mail = M.createCustomerMailer(store, mailer);
  const ts = T.createTicketService(store, { now: c.now, mail });
  const es = E.createEngineerService(store, { now: c.now, auth: fakeAccounts() });
  const svc = I.createInboundService(store, ts, { now: c.now, log: { error() {} }, env: {} });
  return { c, store, ts, es, svc, sent, inbound };
}
let n = 0;
const mailIn = (o = {}) => ({ message_id: `<m${++n}@x>`, from_email: 'someone@client.test', from_name: 'Some One', subject: 'Pump is noisy', body: 'Please send somebody today.', ...o });

(async () => {
  await test('an unknown sender still gets a ticket, marked EXTERNAL-UNVERIFIED, and the sender gets the RECD mail', async () => {
    const w = world();
    const r = await w.svc.handle(mailIn());
    assert.strictEqual(r.outcome, 'ticket_unverified'); assert.match(r.ticket_no, /^PMR/);
    const t = w.store.tickets[0];
    assert.strictEqual(t.source, 'email'); assert.strictEqual(t.unverified, true); assert.strictEqual(t.customer_id, null);
    assert.strictEqual(t.issue_category, 'ISSUE/PROBLEM'); assert.strictEqual(t.contact_email, 'someone@client.test');
    assert.strictEqual(t.site_name, 'EXTERNAL-UNVERIFIED IN AQUIQ SYSTEM');
    await tick(); await tick();
    const m = w.sent.find(x => x.to === 'someone@client.test');
    assert.ok(m, 'mail to the sender');
    assert.strictEqual(m.subject, `RECD - ${r.ticket_no} - Pump is noisy - AQUIQ - EXTERNAL-UNVERIFIED IN AQUIQ SYSTEM`);
    assert.match(m.text, /^EXTERNAL-UNVERIFIED IN AQUIQ SYSTEM/); assert.match(m.text, /Respected Sir\/Ma'am Some One,/);
    assert.match(m.html, /EXTERNAL-UNVERIFIED IN AQUIQ SYSTEM/); assert.strictEqual(m.cc, 'team@aq.test');
  });

  await test('an unverified complaint is hidden from engineers and cannot be assigned until an admin links it to a store', async () => {
    const w = world();
    const eng = await w.es.register({ name: 'Ravi', phone: '9876543210', pincode: '122001', id_proof_type: 'pan', id_proof_ref: 'ABCDE1234F' }, ADMIN);
    await w.svc.handle(mailIn());
    const t = w.store.tickets[0];
    assert.strictEqual((await w.ts.engineerJobs(await w.store.getEngineer(eng.id))).offers.length, 0);
    await ok400(w.ts.act(t.id, { action: 'accept', engineer_id: eng.id, eta_minutes: 30 }, ADMIN), 409, /Link it to a store/);
    const linked = await w.ts.linkCustomer(t.id, CUST, ADMIN);
    assert.strictEqual(linked.unverified, false); assert.strictEqual(linked.customer_id, CUST); assert.strictEqual(linked.site_name, 'Hotel Saffron');
    assert.strictEqual((await w.ts.engineerJobs(await w.store.getEngineer(eng.id))).offers.length, 1, 'now offered to nearby engineers');
    await ok400(w.ts.linkCustomer(t.id, CUST, ADMIN), 409, /already linked/);
  });

  await test('a store email that is confirmed in AQUIQ makes a normal ticket for that store; URGENT in the subject makes it urgent', async () => {
    const w = world({ storeEmail: 'owner@saffron.test' });
    const r = await w.svc.handle(mailIn({ from_email: 'owner@saffron.test', subject: 'URGENT: no water' }));
    assert.strictEqual(r.outcome, 'ticket_created');
    const t = w.store.tickets[0];
    assert.strictEqual(t.customer_id, CUST); assert.strictEqual(t.unverified, false); assert.strictEqual(t.urgency, 'urgent');
    await tick(); await tick();
    const m = w.sent.find(x => x.to === 'owner@saffron.test');
    assert.strictEqual(m.subject, `RECD - ${r.ticket_no} - URGENT: no water - AQUIQ`);
    assert.match(m.text, /"URGENT: no water \(URGENT\)"/);
    assert.ok(!/UNVERIFIED/.test(m.subject + m.text));
  });

  await test('a company account with several stores is unverified, with a hint for the admin', async () => {
    const w = world({ uhad: { id: 'u1', email: 'boss@co.test', company: 'GIPL' }, uhadStores: [customers[CUST], { id: 'x2' }] });
    const r = await w.svc.handle(mailIn({ from_email: 'boss@co.test' }));
    assert.strictEqual(r.outcome, 'ticket_unverified');
    const ev = w.store.events.find(e => e.action === 'created');
    assert.match(ev.meta.hint, /GIPL.*2 stores/);
  });

  await test('a reply that mentions a PMR number is added as a note, not a new ticket', async () => {
    const w = world({ storeEmail: 'owner@saffron.test' });
    const first = await w.svc.handle(mailIn({ from_email: 'owner@saffron.test' }));
    const r = await w.svc.handle(mailIn({ from_email: 'owner@saffron.test', subject: `Re: RECD - ${first.ticket_no} - Pump is noisy - AQUIQ`, body: 'It is worse now' }));
    assert.strictEqual(r.outcome, 'note_added'); assert.strictEqual(w.store.tickets.length, 1);
    const note = w.store.events.filter(e => e.action === 'note').pop();
    assert.match(note.note, /^Email: It is worse now/);
    const stranger = await w.svc.handle(mailIn({ from_email: 'other@x.test', subject: `Re: ${first.ticket_no}`, body: 'hello' }));
    assert.strictEqual(stranger.outcome, 'note_added');
    assert.match(w.store.events.filter(e => e.action === 'note').pop().note, /not the ticket's registered contact/);
  });

  await test('the same mail is never handled twice; a failed mail can be retried', async () => {
    const w = world();
    const m = mailIn();
    await w.svc.handle(m);
    assert.strictEqual((await w.svc.handle(m)).outcome, 'duplicate'); assert.strictEqual(w.store.tickets.length, 1);
    const broken = world(); broken.store.nextSeq = async () => { throw new Error('db down'); };
    const bm = mailIn();
    await assert.rejects(() => broken.svc.handle(bm), /db down/);
    assert.strictEqual(broken.inbound.has(bm.message_id), false, 'released so the script can retry');
  });

  await test('bounces, auto-replies, no-reply senders and our own addresses never become tickets', async () => {
    const w = world();
    for (const o of [
      { from_email: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)' },
      { from_email: 'a@x.test', subject: 'Automatic reply: hello' },
      { from_email: 'a@x.test', auto_submitted: 'auto-replied' },
      { from_email: 'a@x.test', precedence: 'bulk' },
      { from_email: 'noreply@shop.test' },
      { from_email: 'r-tickets@aquiq-prsons.com' },
      { from_email: 'service.bharat@aquiq-prsons.com' },
    ]) assert.strictEqual((await w.svc.handle(mailIn(o))).outcome, 'ignored', JSON.stringify(o));
    assert.strictEqual(w.store.tickets.length, 0);
  });

  await test('one sender can raise at most 5 tickets a day', async () => {
    const w = world();
    for (let i = 0; i < 5; i++) assert.strictEqual((await w.svc.handle(mailIn({ from_email: 'busy@x.test' }))).outcome, 'ticket_unverified');
    assert.strictEqual((await w.svc.handle(mailIn({ from_email: 'busy@x.test' }))).outcome, 'rate_limited');
    assert.strictEqual(w.store.tickets.length, 5);
  });

  await test('the HTTP endpoint needs the shared secret', async () => {
    const w = world();
    const call = (env, headers, body) => new Promise((resolve) => {
      const router = I.createInboundRouter(w.svc, { env });
      const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
      router.stack[0].route.stack[0].handle({ headers, body }, res);
    });
    assert.strictEqual((await call({}, {}, mailIn())).code, 503, 'not configured');
    const env = { INBOUND_SECRET: 'a-long-shared-secret-123' };
    assert.strictEqual((await call(env, {}, mailIn())).code, 401);
    assert.strictEqual((await call(env, { 'x-inbound-secret': 'wrong-wrong-wrong-wrong' }, mailIn())).code, 401);
    const ok = await call(env, { 'x-inbound-secret': 'a-long-shared-secret-123' }, mailIn());
    assert.strictEqual(ok.code, 200); assert.strictEqual(ok.body.outcome, 'ticket_unverified');
    assert.strictEqual((await call(env, { 'x-inbound-secret': 'a-long-shared-secret-123' }, { message_id: 'x' })).code, 400);
  });

  for (const [s, nm] of results) console.log(`${s}  ${nm}`);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})();
