'use strict';
// Run:  node tests/contact.test.js
const assert = require('assert');
const C = require('../contactApi');
const A = require('../accounts');
const { clock, ok400 } = require('./helpers');

let passed = 0; const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + '  ->  ' + e.message]); }
}
const STORE = '11111111-1111-4111-8111-111111111111';
const UHAD = '22222222-2222-4222-8222-222222222222';

function world({ uhadEmail = null, enabled = true } = {}) {
  const c = clock('2026-10-16T06:00:00Z');
  const db = {
    stores: { [STORE]: { id: STORE, name: 'Hotel Saffron', phone: '9999900000', email: null, uhad_id: UHAD } },
    uhads: { [UHAD]: { id: UHAD, name: 'Anuj', company: 'PR', phone: '8888800000', email: uhadEmail } },
  };
  const store = {
    getCustomer: async (id) => db.stores[id] || null,
    getUhad: async (id) => db.uhads[id] || null,
    findUhadByEmail: async (e) => Object.values(db.uhads).find(u => u.email === e) || null,
    setStoreEmail: async (id, e) => { db.stores[id].email = e; },
    setUhadEmail: async (id, e) => { db.uhads[id].email = e; },
    setUhadPhone: async (id, p) => { db.uhads[id].phone = p; },
  };
  const sent = [];
  const mailer = { enabled, send: async (m) => sent.push(m) };
  const svc = C.createContactService(store, mailer, { now: c.now });
  return { c, db, svc, sent };
}
const codeOf = (m) => /code is (\d{6})/.exec(m.text)[1];
const S = { kind: 'store', id: STORE, phone: '99999 00000' };
const U = { kind: 'uhad', id: UHAD, phone: '8888800000' };

(async () => {
  await test('a store adds its email: a code goes to that email, and only the right code saves it', async () => {
    const w = world();
    const r = await w.svc.requestCode({ ...S, email: 'Hotel@Saffron.test' });
    assert.strictEqual(w.sent[0].to, 'hotel@saffron.test');
    assert.match(r.sent_to, /^h\*\*\*@saffron.test$/);
    await ok400(w.svc.confirm({ ...S, token: r.token, code: '000000' }), 400, /not correct/);
    assert.strictEqual(w.db.stores[STORE].email, null);
    const out = await w.svc.confirm({ ...S, token: r.token, code: codeOf(w.sent[0]) });
    assert.strictEqual(out.email, 'hotel@saffron.test');
    assert.strictEqual(w.db.stores[STORE].email, 'hotel@saffron.test');
  });

  await test('a code expires after 10 minutes and cannot be used by another account', async () => {
    const w = world();
    const r = await w.svc.requestCode({ ...S, email: 'a@b.test' });
    const good = codeOf(w.sent[0]);
    w.c.add(11 * 60);
    await ok400(w.svc.confirm({ ...S, token: r.token, code: good }), 400, /expired/);
    w.c.add(-11 * 60);
    await ok400(w.svc.confirm({ ...U, token: r.token, code: good }), 400);
  });

  await test('wrong store or mobile is refused; bad emails are refused; too many attempts are slowed down', async () => {
    const w = world();
    await ok400(w.svc.requestCode({ ...S, phone: '9000000000', email: 'a@b.test' }), 401, /could not verify/);
    await ok400(w.svc.requestCode({ ...S, email: 'not-an-email' }), 400, /valid email/);
    for (let i = 0; i < 5; i++) await w.svc.requestCode({ ...S, email: `a${i}@b.test` });
    await ok400(w.svc.requestCode({ ...S, email: 'z@b.test' }), 429);
  });

  await test('a company account (UHAD) can add an email, but not one already used by another account', async () => {
    const w = world();
    w.db.uhads['33333333-3333-4333-8333-333333333333'] = { id: '33333333-3333-4333-8333-333333333333', phone: '7777700000', email: 'taken@x.test' };
    await ok400(w.svc.requestCode({ ...U, email: 'taken@x.test' }), 409, /already used/);
    const r = await w.svc.requestCode({ ...U, email: 'owner@pr.test' });
    await w.svc.confirm({ ...U, token: r.token, code: codeOf(w.sent[0]) });
    assert.strictEqual(w.db.uhads[UHAD].email, 'owner@pr.test');
  });

  await test('changing a UHAD mobile needs its confirmed email; the code goes to that email', async () => {
    const w = world();
    await ok400(w.svc.requestCode({ ...U, purpose: 'phone', new_phone: '9123456789' }), 409, /email first/);
    const w2 = world({ uhadEmail: 'owner@pr.test' });
    await ok400(w2.svc.requestCode({ ...U, purpose: 'phone', new_phone: '123' }), 400, /10-digit/);
    const r = await w2.svc.requestCode({ ...U, purpose: 'phone', new_phone: '91234 56789' });
    assert.strictEqual(w2.sent[0].to, 'owner@pr.test');
    const out = await w2.svc.confirm({ ...U, token: r.token, code: codeOf(w2.sent[0]) });
    assert.strictEqual(out.phone, '9123456789');
    assert.strictEqual(w2.db.uhads[UHAD].phone, '9123456789');
    await ok400(w2.svc.requestCode({ ...S, purpose: 'phone', new_phone: '9123456789' }), 400, /changed by AQUIQ/);
  });

  await test('with mail switched off, adding an email says so instead of failing silently', async () => {
    const w = world({ enabled: false });
    await ok400(w.svc.requestCode({ ...S, email: 'a@b.test' }), 503, /not set up/);
  });

  await test('admin account list: both kinds, status and running, and NO password ever', async () => {
    const at = clock('2026-10-16T06:00:00Z');
    const store = {
      listUhads: async () => [{ id: UHAD, name: 'Anuj', company: 'PR', email: 'o@pr.test', phone: '8888800000', account_status: 'active', has_password: true }],
      listStores: async () => [
        { id: STORE, name: 'Saffron', phone: '9999900000', email: null, uhad_id: UHAD, last_seen: '2026-10-16T05:58:00Z', account_status: 'active' },
        { id: 's2', name: 'Old', phone: '9000000001', uhad_id: UHAD, last_seen: '2026-10-10T05:58:00Z', account_status: 'removed' },
      ],
      getUhad: async () => ({ id: UHAD, name: 'Anuj', company: 'PR', email: 'o@pr.test', phone: '8888800000' }),
      setUhadPassword: async (id, pw) => { store.last = pw; },
    };
    const svc = A.createAccountsService(store, { now: at.now });
    const out = await svc.list();
    const u = out.accounts.find(a => a.type === 'UHAD');
    assert.strictEqual(u.stores, 2); assert.strictEqual(u.running, 1); assert.strictEqual(u.has_password, true);
    assert.ok(!JSON.stringify(out).toLowerCase().includes('"password"'));
    const s1 = out.accounts.find(a => a.id === STORE); const s2 = out.accounts.find(a => a.id === 's2');
    assert.strictEqual(s1.running, 1); assert.strictEqual(s2.running, 0); assert.strictEqual(s2.status, 'Active' === s2.status ? 'x' : 'Removed');
    const np = await svc.newPassword(UHAD, 'admin');
    assert.match(np.password, /^[A-Za-z0-9]{10}$/); assert.strictEqual(store.last, np.password);
  });

  for (const [s, n] of results) console.log(`${s}  ${n}`);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})();
