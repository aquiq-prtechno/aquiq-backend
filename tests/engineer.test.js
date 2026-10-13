'use strict';
// Run:  node tests/engineer.test.js
// Covers engineer logins, the one-time password, and everything the engineer app may do.
const assert = require('assert');
const express = require('express');
const T = require('../tickets');
const E = require('../engineers');
const API = require('../engineerApi');
const { memStore, clock, ok400, CUST, customers, ADMIN, fakeAccounts } = require('./helpers');

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name + '  ->  ' + e.message]); }
}

const BASE = { phone: '9876543210', pincode: '122001', id_proof_type: 'driving_licence' };
const PHOTO = (ticketId, n = 1) => `jobs/${ticketId}/0000000${n}-0000-4000-8000-000000000000.jpg`;

// A world with a clock, a store, a fake login system, and the services wired as in server.js.
function world() {
  const c = clock('2026-10-13T06:00:00Z');
  const store = memStore(customers);
  const accounts = fakeAccounts();
  const es = E.createEngineerService(store, { now: c.now, auth: accounts });
  const ts = T.createTicketService(store, { now: c.now });
  return { c, store, accounts, es, ts };
}
async function reg(es, name, o = {}) {
  return es.register({ ...BASE, name, phone: o.phone || BASE.phone, id_proof_ref: o.proof || `DL-${name}-1`, ...o }, ADMIN);
}
async function newTicket(ts) { return ts.create({ customer_id: CUST, description: 'No water since morning', issue_category: 'Low or no water flow' }, ADMIN); }
const asEng = async (store, id) => store.getEngineer(id);

(async () => {
  // ── logins and passwords ──
  await test('register: a login is created and a one-time password is returned (never stored)', async () => {
    const { es, store, accounts } = world();
    const e = await reg(es, 'Ravi');
    assert.strictEqual(e.engineer_code, 'ENG-1001');
    assert.match(e.initial_password, /^[A-Za-z0-9]{10}$/);
    assert.ok(/[A-Za-z]/.test(e.initial_password) && /\d/.test(e.initial_password));
    assert.ok(!/[0Ol1I]/.test(e.initial_password), 'no look-alike characters');
    const user = accounts.users.get(e.auth_user_id);
    assert.strictEqual(user.email, 'eng-1001@engineers.prtechno.in');
    assert.strictEqual(user.must_change, true);
    const stored = JSON.stringify(await store.getEngineer(e.id)) + JSON.stringify(store.engineerEvents);
    assert.ok(!stored.includes(e.initial_password), 'the password must not be saved in the record or history');
  });
  await test('register: if saving the record fails, the login is removed again', async () => {
    const { es, store, accounts } = world();
    const real = store.insertEngineer;
    store.insertEngineer = async () => { throw new Error('db down'); };
    await assert.rejects(reg(es, 'Ravi'), /db down/);
    assert.strictEqual(accounts.users.size, 0);
    store.insertEngineer = real;
  });
  await test('password: reset gives a new one-time password; creates the login for an old engineer', async () => {
    const { es, store, accounts } = world();
    const e = await reg(es, 'Ravi');
    const r = await es.issuePassword(e.id, ADMIN);
    assert.notStrictEqual(r.password, e.initial_password);
    assert.strictEqual(accounts.users.get(e.auth_user_id).password, r.password);
    // an engineer registered before logins existed has no login yet
    const legacy = await store.insertEngineer({ engineer_code: 'ENG-0999', name: 'Old', phone: '9000000099', pincode: '122001',
      id_proof_type: 'pan', id_proof_ref: 'ABCDE1234F', status: 'active', radius_km: 30, state_wide: false, auth_user_id: null });
    const made = await es.issuePassword(legacy.id, ADMIN);
    assert.ok(made.password);
    assert.strictEqual((await store.getEngineer(legacy.id)).auth_user_id !== null, true);
    assert.ok(!JSON.stringify(store.engineerEvents).includes(r.password));
  });
  await test('block ends the login; restore brings it back; a blocked engineer cannot get a new password', async () => {
    const { es, accounts } = world();
    const e = await reg(es, 'Ravi');
    await es.block(e.id, 'cheated', ADMIN);
    assert.strictEqual(accounts.users.get(e.auth_user_id).banned, true);
    await ok400(es.issuePassword(e.id, ADMIN), 409, /blocked/);
    await es.restore(e.id, 'cleared', ADMIN);
    assert.strictEqual(accounts.users.get(e.auth_user_id).banned, false);
  });

  // ── offers: what an engineer sees before accepting ──
  await test('offers: only complaints covering the engineer, with area and issue — no name, phone or address', async () => {
    const { es, ts, store } = world();
    const near = await reg(es, 'Ravi');                                         // 122001 — same pincode
    const far = await reg(es, 'Amit', { phone: '9811100000', pincode: '500001' });
    const t = await newTicket(ts);
    const o = (await ts.engineerJobs(await asEng(store, near.id))).offers;
    assert.strictEqual(o.length, 1);
    assert.strictEqual(o[0].ticket_no, t.ticket_no);
    assert.strictEqual(o[0].pincode, '122001');
    for (const k of ['site_name', 'contact_person', 'contact_phone', 'address', 'latitude', 'longitude', 'device_snapshot']) {
      assert.ok(!(k in o[0]), `offer must not reveal ${k}`);
    }
    assert.strictEqual((await ts.engineerJobs(await asEng(store, far.id))).offers.length, 0);
  });
  await test('accept: first engineer wins, the other is told it was taken', async () => {
    const { es, ts, store } = world();
    const a = await reg(es, 'Ravi');
    const b = await reg(es, 'Amit', { phone: '9811100000' });
    const t = await newTicket(ts);
    const ea = await asEng(store, a.id), eb = await asEng(store, b.id);
    const job = await ts.engineerAct(ea, t.id, { action: 'accept', eta_minutes: 30 });
    assert.strictEqual(job.status, 'accepted');
    assert.strictEqual(job.contact_phone, '9999900000');                       // revealed only after accepting
    await ok400(ts.engineerAct(eb, t.id, { action: 'accept' }), 409, /taken by another/);
    assert.strictEqual((await ts.engineerJobs(eb)).offers.length, 0);          // no longer offered
  });
  await test('accept: an engineer cannot take a complaint outside their area', async () => {
    const { es, ts, store } = world();
    const far = await reg(es, 'Amit', { pincode: '500001' });
    const t = await newTicket(ts);
    await ok400(ts.engineerAct(await asEng(store, far.id), t.id, { action: 'accept' }), 403, /outside your area/);
  });
  await test('decline: the complaint disappears for that engineer only, and is logged', async () => {
    const { es, ts, store } = world();
    const a = await reg(es, 'Ravi');
    const b = await reg(es, 'Amit', { phone: '9811100000' });
    const t = await newTicket(ts);
    const ea = await asEng(store, a.id), eb = await asEng(store, b.id);
    await ts.engineerAct(ea, t.id, { action: 'decline', reason: 'on leave' });
    assert.strictEqual((await ts.engineerJobs(ea)).offers.length, 0);
    assert.strictEqual((await ts.engineerJobs(eb)).offers.length, 1);
    assert.ok(store.events.some(e => e.action === 'declined' && e.note === 'on leave'));
  });

  // ── working a job ──
  async function accepted() {
    const w = world();
    const e = await reg(w.es, 'Ravi');
    const t = await newTicket(w.ts);
    const eng = await asEng(w.store, e.id);
    await w.ts.engineerAct(eng, t.id, { action: 'accept' });
    return { ...w, eng, t, e };
  }
  await test('photos: work done needs no photos (they go in the report); photos and videos attach to the job', async () => {
    const { ts, store, eng, t } = await accepted();
    await ts.engineerAct(eng, t.id, { action: 'arrive' });
    store.files.add(PHOTO(t.id, 1));
    await ts.engineerAddPhoto(eng, t.id, { path: PHOTO(t.id, 1), kind: 'other' });
    const job = await ts.engineerAct(eng, t.id, { action: 'work_done' });
    assert.strictEqual(job.status, 'work_done');
    assert.strictEqual(job.photos.length, 1);
    store.files.add(PHOTO(t.id, 2));
    await ts.engineerAddPhoto(eng, t.id, { path: PHOTO(t.id, 2), kind: 'other' });     // still allowed while the report is open
  });
  await test('photos: extra photos are allowed; only image types; only for your own working job', async () => {
    const { ts, store, eng, t, es } = await accepted();
    await ok400(ts.engineerPhotoUpload(eng, t.id, { content_type: 'application/pdf', kind: 'before' }), 400, /JPG, PNG/);
    await ok400(ts.engineerPhotoUpload(eng, t.id, { content_type: 'image/jpeg', kind: 'selfie' }), 400, /before, after or other/);
    const slot = await ts.engineerPhotoUpload(eng, t.id, { content_type: 'image/jpeg', kind: 'other' });
    assert.match(slot.path, new RegExp(`^jobs/${t.id}/[0-9a-f-]{36}\\.jpg$`));
    // another engineer cannot add to this job
    const other = await asEng(store, (await reg(es, 'Amit', { phone: '9811100000' })).id);
    await ok400(ts.engineerPhotoUpload(other, t.id, { content_type: 'image/jpeg', kind: 'before' }), 404, /not assigned/);
  });
  await test('photos: a photo that belongs to a different job, or was never uploaded, is refused', async () => {
    const { ts, store, eng, t } = await accepted();
    const otherJob = '55555555-5555-4555-8555-555555555555';
    store.files.add(PHOTO(otherJob));
    await ok400(ts.engineerAddPhoto(eng, t.id, { path: PHOTO(otherJob), kind: 'before' }), 400, /does not belong/);
    await ok400(ts.engineerAddPhoto(eng, t.id, { path: PHOTO(t.id, 3), kind: 'before' }), 400, /not found/);
    await ok400(ts.engineerAddPhoto(eng, t.id, { path: '../../etc/passwd', kind: 'before' }), 400, /does not belong/);
  });
  await test('jobs: an engineer cannot read or act on someone else\'s job', async () => {
    const { ts, store, t, es } = await accepted();
    const other = await asEng(store, (await reg(es, 'Amit', { phone: '9811100000' })).id);
    await ok400(ts.engineerJob(other, t.id), 404, /not assigned/);
    await ok400(ts.engineerAct(other, t.id, { action: 'arrive' }), 403, /not assigned/);
    await ok400(ts.engineerAct(other, t.id, { action: 'close' }), 400, /not available to engineers/);
  });
  await test('drop: a reason is required; the job goes back to open and out to everyone', async () => {
    const { ts, eng, t } = await accepted();
    await ok400(ts.engineerAct(eng, t.id, { action: 'drop' }), 400, /note/i);
    await ts.engineerAct(eng, t.id, { action: 'drop', note: 'vehicle broke down' }).catch(() => {});
    const d = await ts.detail(t.id);
    assert.strictEqual(d.ticket.status, 'open');
    assert.strictEqual(d.ticket.engineer_id, null);
  });
  await test('admin sees the photos through short-lived links', async () => {
    const { ts, store, eng, t } = await accepted();
    store.files.add(PHOTO(t.id, 1));
    await ts.engineerAddPhoto(eng, t.id, { path: PHOTO(t.id, 1), kind: 'before' });
    const d = await ts.detail(t.id);
    assert.strictEqual(d.photos.length, 1);
    assert.match(d.photos[0].url, /^https:\/\/signed\.test\/job-photos\/jobs\//);
  });

  // ── the HTTP API with the real sign-in rules ──
  await test('HTTP: sign-in rules, forced first-login password change, blocked engineer shut out at once', async () => {
    const { es, ts, store, accounts } = world();
    const e = await reg(es, 'Ravi');
    const t = await newTicket(ts);
    // fake Supabase auth: token "tok-<userId>" -> that user
    const supabase = { auth: { getUser: async (tok) => {
      const id = String(tok).replace('tok-', '');
      const u = accounts.users.get(id);
      if (!u) return { data: { user: null }, error: { message: 'bad' } };
      return { data: { user: { id, banned_until: u.banned ? '2999-01-01T00:00:00Z' : null,
        app_metadata: { role: 'engineer', engineer_id: u.engineerId, must_change_password: u.must_change } } }, error: null };
    } } };
    const app = express();
    app.use(express.json());
    app.use('/engineer', API.createEngineerApiRouter({
      tickets: ts, store, accounts, auth: API.createEngineerAuth(supabase, store),
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/engineer`;
    const call = async (path, { token, body, method } = {}) => {
      const r = await fetch(base + path, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      return { s: r.status, b: await r.json() };
    };
    const tok = `tok-${e.auth_user_id}`;
    try {
      assert.strictEqual((await call('/jobs')).s, 401);                                    // no token
      assert.strictEqual((await call('/jobs', { token: 'tok-nope' })).s, 401);              // unknown token
      const gate = await call('/jobs', { token: tok });                                     // first login: must set password
      assert.strictEqual(gate.s, 403); assert.strictEqual(gate.b.code, 'password_change_required');
      const me = await call('/me', { token: tok });
      assert.strictEqual(me.s, 200); assert.strictEqual(me.b.must_change_password, true); assert.strictEqual(me.b.engineer.engineer_code, 'ENG-1001');
      assert.strictEqual((await call('/password', { token: tok, body: { new_password: 'short' } })).s, 400);
      assert.strictEqual((await call('/password', { token: tok, body: { new_password: 'onlyletters' } })).s, 400);
      assert.strictEqual((await call('/password', { token: tok, body: { new_password: 'MyOwn2026pw' } })).s, 200);
      assert.strictEqual(accounts.users.get(e.auth_user_id).must_change, false);

      const jobs = await call('/jobs', { token: tok });
      assert.strictEqual(jobs.s, 200); assert.strictEqual(jobs.b.offers.length, 1);
      const acc = await call(`/jobs/${t.id}/action`, { token: tok, body: { action: 'accept', eta_minutes: 40 } });
      assert.strictEqual(acc.s, 200); assert.strictEqual(acc.b.job.status, 'accepted');
      assert.strictEqual((await call(`/jobs/${t.id}/action`, { token: tok, body: { action: 'work_done' } })).s, 409);   // not arrived yet
      assert.strictEqual((await call('/device', { token: tok, body: { token: 'ExponentPushToken[abcdefghij]', platform: 'android' } })).s, 200);
      assert.strictEqual(store.devices.length, 1);

      await es.block(e.id, 'cheated', ADMIN);                                              // admin blocks
      const after = await call('/jobs', { token: tok });                                    // same token, instantly refused
      assert.strictEqual(after.s, 403); assert.strictEqual(after.b.code, 'disabled');
    } finally { server.close(); }
  });

  for (const [s, n] of results) console.log(`${s}  ${n}`);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})();
