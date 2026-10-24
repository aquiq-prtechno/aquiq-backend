'use strict';
// Run:  node tests/contact.test.js
const assert = require('assert');
const C = require('../contactApi');
const A = require('../accounts');
const PW = require('../passwords');
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
    setAppVersion: async (k, id, v) => { (k === 'uhad' ? db.uhads : db.stores)[id].app_version = v; },
    findUhadFull: async (e) => Object.values(db.uhads).find(u => u.email === e) || null,
    setUhadPasswordHash: async (id, h) => { db.uhads[id].password_hash = h; db.uhads[id].password = null; },
    findStoresByVerifiedEmail: async (e) => Object.values(db.stores).filter(x => x.email === e && x.verified),
  };
  const sent = [];
  const mailer = { enabled, senderFor: (k) => (k === 'accounts' ? { address: 'info.fs.reports-no-reply@aq.test', name: 'AQUIQ Service Desk' } : null), send: async (m) => sent.push(m) };
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
    assert.match(np.password, /^[A-Za-z0-9]{10}$/); assert.ok(PW.verifyPassword(np.password, store.last), 'stored as a hash'); assert.notStrictEqual(store.last, np.password);
  });

  await test('a store logs in with a verified email and a 6-digit code', async () => {
    const w = world();
    w.db.stores[STORE].email = 'hotel@saffron.test'; w.db.stores[STORE].verified = true;
    const r = await w.svc.loginCode({ email: 'Hotel@Saffron.test' });
    assert.strictEqual(w.sent.length, 1); assert.match(w.sent[0].subject, /login code/);
    await ok400(w.svc.loginConfirm({ email: 'hotel@saffron.test', token: r.token, code: '123456' }), 400, /not correct/);
    const out = await w.svc.loginConfirm({ email: 'hotel@saffron.test', token: r.token, code: codeOf(w.sent[0]) });
    assert.strictEqual(out.stores.length, 1); assert.strictEqual(out.stores[0].id, STORE);
    await ok400(w.svc.loginConfirm({ email: 'other@x.test', token: r.token, code: codeOf(w.sent[0]) }), 400);
    w.c.add(11 * 60);
    await ok400(w.svc.loginConfirm({ email: 'hotel@saffron.test', token: r.token, code: codeOf(w.sent[0]) }), 400, /expired/);
  });

  await test('login by email: an unknown or unconfirmed email gets the same answer and no email is sent', async () => {
    const w = world();
    w.db.stores[STORE].email = 'unconfirmed@x.test';          // not verified
    const a = await w.svc.loginCode({ email: 'nobody@x.test' });
    const b = await w.svc.loginCode({ email: 'unconfirmed@x.test' });
    assert.strictEqual(w.sent.length, 0);
    assert.ok(a.token && b.token);
    await ok400(w.svc.loginConfirm({ email: 'nobody@x.test', token: a.token, code: '000000' }), 400);
  });

  await test('login codes cannot be brute-forced', async () => {
    const w = world();
    w.db.stores[STORE].email = 'h@x.test'; w.db.stores[STORE].verified = true;
    const r = await w.svc.loginCode({ email: 'h@x.test' });
    for (let i = 0; i < 8; i++) await ok400(w.svc.loginConfirm({ email: 'h@x.test', token: r.token, code: String(111110 + i) }), 400);
    await ok400(w.svc.loginConfirm({ email: 'h@x.test', token: r.token, code: '999999' }), 429);
  });

  await test('company login: hashed passwords work, old plain-text ones work once and are upgraded, wrong ones are refused', async () => {
    const w = world({ uhadEmail: 'owner@pr.test' });
    w.db.uhads[UHAD].password = 'OldPass123';                     // legacy plain text
    await ok400(w.svc.uhadLogin({ email: 'owner@pr.test', password: 'wrong' }), 401, /incorrect/);
    const r = await w.svc.uhadLogin({ email: 'Owner@PR.test', password: 'OldPass123' });
    assert.strictEqual(r.uhad.id, UHAD);
    assert.ok(!('password' in r.uhad) && !('password_hash' in r.uhad), 'no password fields leave the server');
    assert.ok(w.db.uhads[UHAD].password_hash.startsWith('scrypt$'));
    assert.strictEqual(w.db.uhads[UHAD].password, null);          // plain text removed after the upgrade
    await w.svc.uhadLogin({ email: 'owner@pr.test', password: 'OldPass123' });   // still works, now from the hash
    await ok400(w.svc.uhadLogin({ email: 'nobody@pr.test', password: 'x' }), 401, /incorrect/);
  });

  await test('forgot password: a code by email, then a new password the customer chooses', async () => {
    const w = world({ uhadEmail: 'owner@pr.test' });
    const f = await w.svc.uhadForgot({ email: 'owner@pr.test' });
    assert.match(w.sent[0].subject, /Reset your AQUIQ password/);
    await ok400(w.svc.uhadReset({ email: 'owner@pr.test', token: f.token, code: '000000', new_password: 'NewPass2026' }), 400, /not correct/);
    await ok400(w.svc.uhadReset({ email: 'owner@pr.test', token: f.token, code: codeOf(w.sent[0]), new_password: 'short' }), 400, /8 characters/);
    await w.svc.uhadReset({ email: 'owner@pr.test', token: f.token, code: codeOf(w.sent[0]), new_password: 'NewPass2026' });
    const r = await w.svc.uhadLogin({ email: 'owner@pr.test', password: 'NewPass2026' });
    assert.strictEqual(r.uhad.id, UHAD);
    await ok400(w.svc.uhadLogin({ email: 'owner@pr.test', password: 'OldPass123' }), 401);
  });

  await test('confirmation, login and password-reset codes are sent from the accounts sender (the reports address), not the default mailbox', async () => {
    const w = world();
    await w.svc.requestCode({ ...S, email: 'hotel@saffron.test' });
    const reset = world({ uhadEmail: 'owner@pr.test' });
    await reset.svc.uhadForgot({ email: 'owner@pr.test' });
    const login = world();
    login.db.stores[STORE].email = 'hotel@saffron.test'; login.db.stores[STORE].verified = true;
    await login.svc.loginCode({ email: 'hotel@saffron.test' });
    assert.strictEqual(reset.sent[0].to, 'owner@pr.test', 'the reset code goes to the email of that company account');
    const all = [...w.sent, ...reset.sent, ...login.sent];
    assert.strictEqual(all.length, 3, 'one code mail from each of the three flows');
    for (const m of all) assert.deepStrictEqual(m.from, { address: 'info.fs.reports-no-reply@aq.test', name: 'AQUIQ Service Desk' });
  });

  await test('forgot password never reveals whether an email exists; codes expire and cannot be guessed', async () => {
    const w = world({ uhadEmail: 'owner@pr.test' });
    const a = await w.svc.uhadForgot({ email: 'nobody@x.test' });
    assert.strictEqual(w.sent.length, 0); assert.ok(a.token);
    await ok400(w.svc.uhadReset({ email: 'nobody@x.test', token: a.token, code: '123456', new_password: 'NewPass2026' }), 400);
    const f = await w.svc.uhadForgot({ email: 'owner@pr.test' });
    const good = codeOf(w.sent[0]);
    w.c.add(11 * 60);
    await ok400(w.svc.uhadReset({ email: 'owner@pr.test', token: f.token, code: good, new_password: 'NewPass2026' }), 400, /expired/);
  });

  await test('password hashing: salted, verifies, rejects wrong, strength rule', async () => {
    const h1 = PW.hashPassword('Secret123'); const h2 = PW.hashPassword('Secret123');
    assert.notStrictEqual(h1, h2);
    assert.ok(PW.verifyPassword('Secret123', h1)); assert.ok(!PW.verifyPassword('secret123', h1));
    assert.ok(!PW.verifyPassword('x', 'not-a-hash'));
    assert.ok(PW.strongEnough('abcdefg1') && !PW.strongEnough('abcdefgh') && !PW.strongEnough('a1'));
  });

  await test('the app reports its version; the admin list flags old versions', async () => {
    const V = require('../versions');
    const w = world();
    await w.svc.ping({ ...S, version: '1.2.0' });
    assert.strictEqual(w.db.stores[STORE].app_version, '1.2.0');
    await ok400(w.svc.ping({ ...S, version: 'abc' }), 400);
    await ok400(w.svc.ping({ ...S, phone: '9000000000', version: '1.4.0' }), 401);
    assert.strictEqual(V.isOld('1.2.0', 'customer'), true);
    assert.strictEqual(V.isOld(V.LATEST.customer, 'customer'), false);
    assert.strictEqual(V.isOld(null, 'customer'), false);
    assert.strictEqual(V.compare('1.10.0', '1.9.0'), 1);
    const store = {
      listUhads: async () => [], listStores: async () => [{ id: STORE, name: 'S', phone: '9', uhad_id: 'x', app_version: '1.2.0', account_status: 'active' }],
    };
    const out = await A.createAccountsService(store).list();
    assert.strictEqual(out.accounts[0].app_old, true);
    assert.strictEqual(out.latest_version, V.LATEST.customer);
  });

  for (const [s, n] of results) console.log(`${s}  ${n}`);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})();
