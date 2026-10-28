'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { inviteMail, resetMail, createLimiter } = require('../authMail');

test('invite and reset mails use the AQUIQ layout, the link and the right subject', () => {
  const link = 'https://x.test/auth?token=a&b=c';
  const r = resetMail({ email: 'a@b.com', link });
  assert.strictEqual(r.subject, 'Reset your AQUIQ password');
  assert.match(r.html, /email-logo\.png/); assert.match(r.html, /Reset my password/); assert.match(r.html, /token=a&amp;b=c/); assert.match(r.text, /token=a&b=c/);
  const i = inviteMail({ email: 'a@b.com', link });
  assert.strictEqual(i.subject, 'You have been invited to AQUIQ');
  assert.match(i.html, /Accept invite/); assert.match(i.html, /text-align:center/);
  assert.ok(!/<script/i.test(resetMail({ email: '<script>', link }).html), 'email is escaped');
});

test('the limiter allows a few uses per window, then refuses, then lets go', () => {
  let t = 0; const ok = createLimiter(2, 1000, () => t);
  assert.ok(ok('k')); assert.ok(ok('k')); assert.ok(!ok('k')); assert.ok(ok('other'));
  t = 1500; assert.ok(ok('k'));
});
