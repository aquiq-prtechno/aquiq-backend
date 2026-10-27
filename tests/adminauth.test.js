'use strict';
// Run:  node tests/adminauth.test.js
const assert = require('assert');
const { authorize, PERMS } = require('../adminAuth');

let passed = 0; const results = [];
function test(name, fn) {
  try { fn(); passed += 1; results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + '  ->  ' + e.message]); }
}
const perms = (...on) => Object.fromEntries(PERMS.map(k => [k, on.includes(k)]));
const owner = { role: 'owner', state: 'active', perms: perms() };
const emp = (state, ...on) => ({ role: 'staff', state, perms: perms(...on) });

test('owner may do everything', () => {
  for (const [m, p] of [['POST', '/admin/team/invite'], ['POST', '/admin/tickets/1/action'], ['POST', '/device/wifi/X'], ['GET', '/admin/activity'], ['POST', '/admin/team/9/access']]) assert.ok(authorize(owner, m, p, {}).ok, p);
});
test('Team (Emp) read-only: can read, cannot change anything', () => {
  const u = emp('readonly', 'tickets_work', 'tickets_cancel', 'device_controls');
  assert.ok(authorize(u, 'GET', '/admin/tickets', {}).ok);
  assert.ok(authorize(u, 'GET', '/admin/accounts', {}).ok);
  const r = authorize(u, 'POST', '/admin/tickets/1/action', { action: 'note' });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'readonly');
  assert.strictEqual(authorize(u, 'POST', '/device/command/X', {}).code, 'readonly');
});
test('active with no rights switched on: cannot change anything', () => {
  const u = emp('active');
  for (const [m, p, b] of [['POST', '/admin/tickets/1/action', { action: 'accept' }], ['POST', '/admin/engineers', {}], ['POST', '/device/wifi/X', {}], ['POST', '/admin/accounts/uhad/1/password', {}]]) assert.strictEqual(authorize(u, m, p, b).ok, false, p);
});
test('tickets_work does not include cancel; tickets_cancel is separate', () => {
  const w = emp('active', 'tickets_work');
  assert.ok(authorize(w, 'POST', '/admin/tickets/1/action', { action: 'note' }).ok);
  assert.strictEqual(authorize(w, 'POST', '/admin/tickets/1/action', { action: 'cancel' }).ok, false);
  assert.ok(authorize(emp('active', 'tickets_cancel'), 'POST', '/admin/tickets/1/action', { action: 'cancel' }).ok);
});
test('engineers, accounts, device controls, mail each need their own right', () => {
  assert.ok(authorize(emp('active', 'engineers_manage'), 'POST', '/admin/engineers/5/block', {}).ok);
  assert.strictEqual(authorize(emp('active', 'tickets_work'), 'POST', '/admin/engineers/5/block', {}).ok, false);
  assert.ok(authorize(emp('active', 'accounts_add'), 'POST', '/admin/accounts/uhad/1/password', {}).ok);
  assert.ok(authorize(emp('active', 'device_controls'), 'POST', '/device/wifi/X/clear', {}).ok);
  assert.ok(authorize(emp('active', 'mail_settings'), 'POST', '/admin/mail-test', {}).ok);
  assert.strictEqual(authorize(emp('active'), 'GET', '/admin/mail-status', {}).ok, false);
});
test('team routes: only add_team may invite or view the team; owner-only actions are never allowed', () => {
  assert.ok(authorize(emp('active', 'add_team'), 'POST', '/admin/team/invite', {}).ok);
  assert.ok(authorize(emp('active', 'add_team'), 'GET', '/admin/team', {}).ok);
  assert.strictEqual(authorize(emp('active'), 'POST', '/admin/team/invite', {}).ok, false);
  assert.strictEqual(authorize(emp('readonly', 'add_team'), 'POST', '/admin/team/invite', {}).ok, false);
  for (const p of ['/admin/team/9/access', '/admin/team/9/disable', '/admin/activity']) assert.strictEqual(authorize(emp('active', ...PERMS), 'POST', p, {}).ok, false, p);
});
test('an unlisted change is refused for Team (Emp), even with every right on', () => {
  assert.strictEqual(authorize(emp('active', ...PERMS), 'POST', '/admin/something-new', {}).ok, false);
});
test('/admin/me is open to every signed-in person', () => {
  assert.ok(authorize(emp('readonly'), 'GET', '/admin/me', {}).ok);
});

for (const [s, n] of results) console.log(`${s}  ${n}`);
const failed = results.filter(r => r[0] === 'FAIL').length;
console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
process.exit(failed ? 1 : 0);
