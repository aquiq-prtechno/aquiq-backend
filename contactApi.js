'use strict';
// Contact details of a customer account, edited from the customer app's Settings:
//   - a store (UHSA, logs in with its mobile number) can add an email for service updates and reports;
//   - a company account (UHAD) can add an email, or change its mobile number.
// Every change is confirmed with a 6-digit code sent to the new email, so nobody can point
// someone else's reports at an address they do not own.

const crypto = require('crypto');
const express = require('express');
const fileLinks = require('./fileLinks');
const { hashPassword, verifyPassword, strongEnough, sameText } = require('./passwords');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(-10);
const httpError = (status, message) => { const e = new Error(message); e.status = status; return e; };
const secret = () => process.env.LINK_SECRET || process.env.SUPABASE_SERVICE_KEY || 'aquiq-dev-link-secret';
const hash = (code, token) => crypto.createHmac('sha256', secret()).update(`${code}|${token}`).digest('hex');

function createContactService(store, mailer, { now = () => new Date() } = {}) {
  const asked = new Map();          // `${id}|${hour}` -> count (keeps code requests reasonable)
  const throttle = (id, limit, bucket = 'ask') => {
    const hour = Math.floor(now().getTime() / 3600000);
    const key = `${bucket}|${id}|${hour}`;
    const n = (asked.get(key) || 0) + 1;
    asked.set(key, n);
    for (const k of asked.keys()) if (!k.endsWith(`|${hour}`)) asked.delete(k);
    if (n > limit) throw httpError(429, 'Too many attempts. Please try again in an hour.');
  };

  // who is asking: a store (id + its registered mobile) or a company account (id + its mobile)
  async function who(input) {
    const kind = input.kind === 'uhad' ? 'uhad' : 'store';
    const id = String(input.id || '');
    const row = UUID_RE.test(id) ? (kind === 'uhad' ? await store.getUhad(id) : await store.getCustomer(id)) : null;
    if (!row || digits(row.phone).length !== 10 || digits(row.phone) !== digits(input.phone)) {
      throw httpError(401, 'We could not verify this account. Please log in again.');
    }
    return { kind, id, row };
  }

  async function current(input) {
    const a = await who(input);
    const email = a.kind === 'uhad' ? a.row.email : (a.row.email || null);
    return { kind: a.kind, email: email || null, phone: a.row.phone || null, uses_company_email: a.kind === 'store' && !a.row.email };
  }

  async function requestCode(input) {
    const a = await who(input);
    const purpose = input.purpose === 'phone' ? 'phone' : 'email';
    if (!mailer || !mailer.enabled) throw httpError(503, 'Email is not set up yet. Please contact AQUIQ.');
    let target; let sendTo; let value;
    if (purpose === 'email') {
      value = String(input.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(value)) throw httpError(400, 'Enter a valid email address.');
      if (a.kind === 'uhad' && (await store.findUhadByEmail(value)) && (await store.findUhadByEmail(value)).id !== a.id) {
        throw httpError(409, 'That email is already used by another AQUIQ account.');
      }
      sendTo = value; target = 'email';
    } else {
      if (a.kind !== 'uhad') throw httpError(400, 'Mobile numbers are changed by AQUIQ for stores.');
      value = digits(input.new_phone);
      if (value.length !== 10) throw httpError(400, 'Enter a valid 10-digit mobile number.');
      if (!a.row.email) throw httpError(409, 'Add and confirm an email first. We send the confirmation code there.');
      sendTo = a.row.email; target = 'phone';
    }
    throttle(a.id, 5);
    const code = String(crypto.randomInt(100000, 1000000));
    const token = fileLinks.sign({ k: 'contact', kind: a.kind, id: a.id, purpose, value }, 600, now().getTime());
    await mailer.send({
      from: mailer.senderFor ? mailer.senderFor('accounts') : undefined,
      to: sendTo, subject: 'Your AQUIQ confirmation code',
      text: `Your AQUIQ confirmation code is ${code}.\n\nIt works for 10 minutes. ${target === 'email' ? 'It confirms that this email address belongs to you, so AQUIQ can send you service updates and reports.' : 'It confirms the change of your mobile number.'}\n\nIf you did not ask for this, you can ignore this email.\n\nAQUIQ Service Desk`,
    });
    return { token: `${token}.${hash(code, token)}`, sent_to: sendTo.replace(/^(.).*(@.*)$/, '$1***$2') };
  }

  async function confirm(input) {
    const a = await who(input);
    // token format: <payload>.<mac>.<codehash>
    const parts = String(input.token || '').split('.');
    if (parts.length !== 3) throw httpError(400, 'That code is not valid. Please ask for a new one.');
    const signed = `${parts[0]}.${parts[1]}`;
    const p = fileLinks.verify(signed, now().getTime());
    if (!p || p.k !== 'contact' || p.id !== a.id || p.kind !== a.kind) throw httpError(400, 'That code has expired. Please ask for a new one.');
    const want = hash(String(input.code || '').trim(), signed);
    if (parts[2].length !== want.length || !crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(want))) {
      throttle(a.id, 8, 'wrong');                    // a 6-digit code cannot be guessed by trying them all
      throw httpError(400, 'That code is not correct.');
    }
    if (p.purpose === 'email') {
      if (a.kind === 'uhad') await store.setUhadEmail(a.id, p.value); else await store.setStoreEmail(a.id, p.value);
      return { ok: true, email: p.value };
    }
    await store.setUhadPhone(a.id, p.value);
    return { ok: true, phone: p.value };
  }

  // ── store login with a verified email: a 6-digit code replaces typing a password ──
  async function loginCode(input) {
    const email = String(input.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address.');
    throttle(email, 5, 'login');
    if (!mailer || !mailer.enabled) throw httpError(503, 'Email login is not available yet. Please use your mobile number.');
    const stores = await store.findStoresByVerifiedEmail(email);
    const code = String(crypto.randomInt(100000, 1000000));
    const token = fileLinks.sign({ k: 'login', email }, 600, now().getTime());
    // same answer whether or not the email is registered, so nobody can probe which emails exist
    if (stores.length) {
      await mailer.send({
        from: mailer.senderFor ? mailer.senderFor('accounts') : undefined,
        to: email, subject: 'Your AQUIQ login code',
        text: `Your AQUIQ login code is ${code}.\n\nIt works for 10 minutes. If you did not try to log in, you can ignore this email.\n\nAQUIQ Service Desk`,
      });
    }
    return { token: `${token}.${hash(code, token)}`, sent_to: email.replace(/^(.).*(@.*)$/, '$1***$2') };
  }

  async function loginConfirm(input) {
    const email = String(input.email || '').trim().toLowerCase();
    const parts = String(input.token || '').split('.');
    const bad = () => httpError(400, 'That code is not correct or has expired.');
    if (parts.length !== 3) throw bad();
    const signed = `${parts[0]}.${parts[1]}`;
    const p = fileLinks.verify(signed, now().getTime());
    if (!p || p.k !== 'login' || p.email !== email) throw bad();
    const want = hash(String(input.code || '').trim(), signed);
    if (parts[2].length !== want.length || !crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(want))) {
      throttle(email, 8, 'loginwrong');
      throw bad();
    }
    const stores = await store.findStoresByVerifiedEmail(email);
    if (!stores.length) throw bad();
    return { stores };
  }

  // ── company account (UHAD): log in, and create a new password if it was forgotten ──
  const publicUhad = ({ password, password_hash, ...rest }) => rest;

  async function uhadLogin(input) {
    const email = String(input.email || '').trim().toLowerCase();
    const password = String(input.password || '');
    const fail = () => httpError(401, 'Email or password is incorrect.');
    if (!EMAIL_RE.test(email) || !password) throw fail();
    const u = await store.findUhadFull(email);
    let ok = false;
    if (u) {
      if (u.password_hash) ok = verifyPassword(password, u.password_hash);
      else if (u.password) ok = sameText(password, u.password);
    } else {
      hashPassword('timing');            // same work whether or not the account exists
    }
    if (!ok) { throttle(email, 10, 'uhadwrong'); throw fail(); }
    if (!u.password_hash) await store.setUhadPasswordHash(u.id, hashPassword(password));   // upgrade the old plain-text password
    return { uhad: publicUhad(u) };
  }

  async function uhadForgot(input) {
    const email = String(input.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter your registered email address.');
    throttle(email, 5, 'forgot');
    if (!mailer || !mailer.enabled) throw httpError(503, 'Password reset by email is not available yet. Please contact AQUIQ support.');
    const u = await store.findUhadFull(email);
    const code = String(crypto.randomInt(100000, 1000000));
    const token = fileLinks.sign({ k: 'uhadreset', email }, 600, now().getTime());
    if (u) {
      await mailer.send({
        from: mailer.senderFor ? mailer.senderFor('accounts') : undefined,
        to: email, subject: 'Reset your AQUIQ password',
        text: `Your AQUIQ password reset code is ${code}.\n\nIt works for 10 minutes. Enter it in the app and choose a new password. If you did not ask for this, ignore this email; your password has not changed.\n\nAQUIQ Service Desk`,
      });
    }
    return { token: `${token}.${hash(code, token)}`, sent_to: email.replace(/^(.).*(@.*)$/, '$1***$2') };
  }

  async function uhadReset(input) {
    const email = String(input.email || '').trim().toLowerCase();
    const bad = () => httpError(400, 'That code is not correct or has expired.');
    const parts = String(input.token || '').split('.');
    if (parts.length !== 3) throw bad();
    const signed = `${parts[0]}.${parts[1]}`;
    const p = fileLinks.verify(signed, now().getTime());
    if (!p || p.k !== 'uhadreset' || p.email !== email) throw bad();
    const want = hash(String(input.code || '').trim(), signed);
    if (parts[2].length !== want.length || !crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(want))) {
      throttle(email, 8, 'resetwrong');
      throw bad();
    }
    if (!strongEnough(input.new_password)) throw httpError(400, 'Use at least 8 characters, with letters and numbers.');
    const u = await store.findUhadFull(email);
    if (!u) throw bad();
    await store.setUhadPasswordHash(u.id, hashPassword(input.new_password));
    return { ok: true };
  }

  // The app tells us which release it is, so the admin can see who still runs an old one.
  async function ping(input) {
    const a = await who(input);
    const version = String(input.version || '').slice(0, 20);
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw httpError(400, 'Invalid version.');
    await store.setAppVersion(a.kind, a.id, version);
    return { ok: true };
  }

  return { current, requestCode, confirm, loginCode, loginConfirm, uhadLogin, uhadForgot, uhadReset, ping };
}

function createContactRouter(service) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (err) {
      if (!err.status || err.status >= 500) console.error('[CONTACT]', err.message, err.detail || '');
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong. Please try again.' });
    }
  };
  router.post('/current', wrap((req) => service.current(req.body || {})));
  router.post('/code', wrap((req) => service.requestCode(req.body || {})));
  router.post('/confirm', wrap((req) => service.confirm(req.body || {})));
  router.post('/ping', wrap((req) => service.ping(req.body || {})));
  router.post('/uhad/login', wrap((req) => service.uhadLogin(req.body || {})));
  router.post('/uhad/forgot', wrap((req) => service.uhadForgot(req.body || {})));
  router.post('/uhad/reset', wrap((req) => service.uhadReset(req.body || {})));
  router.post('/login/code', wrap((req) => service.loginCode(req.body || {})));
  router.post('/login/confirm', wrap((req) => service.loginConfirm(req.body || {})));
  return router;
}

function supabaseContactStore(sb) {
  const one = async (q) => { const { data, error } = await q; if (error) { const e = httpError(500, 'Database error.'); e.detail = error.message; throw e; } return data; };
  return {
    getUhad: (id) => one(sb.from('uhads').select('id,name,phone,email').eq('id', id).maybeSingle()),
    getCustomer: (id) => one(sb.from('customers').select('id,name,phone,email,uhad_id').eq('id', id).maybeSingle()),
    findUhadByEmail: (email) => one(sb.from('uhads').select('id').eq('email', email).maybeSingle()),
    async setAppVersion(kind, id, version) {
      await one(sb.from(kind === 'uhad' ? 'uhads' : 'customers').update({ app_version: version, app_seen_at: new Date().toISOString() }).eq('id', id));
    },
    findUhadFull: (email) => one(sb.from('uhads').select('*').eq('email', email).maybeSingle()),
    // from now on the password is kept only as a hash; the old plain-text column is emptied
    async setUhadPasswordHash(id, passwordHash) { await one(sb.from('uhads').update({ password_hash: passwordHash, password: null }).eq('id', id)); },
    // stores whose own email was confirmed with a code: the only ones allowed to log in by email
    findStoresByVerifiedEmail: (email) => one(sb.from('customers').select('*, uhads(id, name, company, email)')
      .eq('role', 'uhsa').eq('email', email).not('email_verified_at', 'is', null)),
    async setStoreEmail(id, email) { await one(sb.from('customers').update({ email, email_verified_at: new Date().toISOString() }).eq('id', id)); },
    async setUhadEmail(id, email) { await one(sb.from('uhads').update({ email }).eq('id', id)); },
    async setUhadPhone(id, phone) { await one(sb.from('uhads').update({ phone }).eq('id', id)); },
  };
}

module.exports = { createContactService, createContactRouter, supabaseContactStore };
