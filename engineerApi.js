'use strict';
// The API behind the AQUIQ SE-TECH engineer app.
//
// Everything lives under /engineer and needs the engineer's own login token.
// Every request re-checks that the engineer is still registered and ACTIVE, so a
// blocked engineer is shut out at once even if their phone still holds a valid token.
// An engineer can only ever reach their own jobs and the offers covering their area.

const express = require('express');

const MESSAGES = {
  missing_token: 'Sign in required.',
  invalid_token: 'Your session has expired. Sign in again.',
  disabled: 'This account has been switched off. Contact AQUIQ.',
  no_role: 'This account is not an engineer account.',
  auth_unavailable: 'Could not verify your session right now. Try again.',
  password_change_required: 'Set your own password before you continue.',
};
const STATUS = { missing_token: 401, invalid_token: 401, disabled: 403, no_role: 403, auth_unavailable: 503, password_change_required: 403 };

function createEngineerAuth(supabase, store) {
  async function identify(req) {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) return { error: 'missing_token' };
    let r;
    try { r = await supabase.auth.getUser(m[1]); } catch { return { error: 'auth_unavailable' }; }
    const user = r.data && r.data.user;
    if (r.error || !user) return { error: 'invalid_token' };
    if (user.banned_until && new Date(user.banned_until) > new Date()) return { error: 'disabled' };

    const meta = user.app_metadata || {};
    if (meta.role !== 'engineer' || !meta.engineer_id) return { error: 'no_role' };
    const engineer = await store.getEngineer(meta.engineer_id);
    if (!engineer || engineer.auth_user_id !== user.id) return { error: 'no_role' };
    if (engineer.status !== 'active') return { error: 'disabled' };
    return { engineer, user, mustChange: !!meta.must_change_password };
  }
  return { identify };
}

function strongEnough(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 72 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
}

function createEngineerApiRouter({ tickets, store, auth, accounts, reports }) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // identify every request; most routes also require the first-login password change to be done
  const guard = (allowBeforePasswordChange = false) => async (req, res, next) => {
    const who = await auth.identify(req);
    if (who.error) return res.status(STATUS[who.error] || 403).json({ error: MESSAGES[who.error], code: who.error });
    if (who.mustChange && !allowBeforePasswordChange) {
      return res.status(403).json({ error: MESSAGES.password_change_required, code: 'password_change_required' });
    }
    req.engineer = who.engineer; req.engUser = who.user; req.mustChange = who.mustChange;
    next();
  };
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      if (!err.status || err.status >= 500) console.error('[ENGINEER API]', err.message, err.detail || '');
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong.' });
    }
  };

  router.get('/me', guard(true), wrap(async (req) => ({
    engineer: {
      engineer_code: req.engineer.engineer_code, name: req.engineer.name, phone: req.engineer.phone,
      pincode: req.engineer.pincode, city: req.engineer.city,
    },
    must_change_password: req.mustChange,
  })));

  router.post('/password', guard(true), wrap(async (req) => {
    const pw = (req.body || {}).new_password;
    if (!strongEnough(pw)) {
      const e = new Error('Use at least 8 characters, with letters and numbers.'); e.status = 400; throw e;
    }
    await accounts.changePassword(req.engUser.id, pw);
    return { ok: true };
  }));

  router.get('/history', guard(), wrap(async (req) => ({ jobs: await tickets.engineerHistory(req.engineer) })));
  router.post('/jobs/:id/location', guard(), wrap((req) => tickets.engineerLocation(req.engineer, req.params.id, req.body || {})));
  router.get('/jobs', guard(), wrap((req) => tickets.engineerJobs(req.engineer)));
  router.get('/jobs/:id', guard(), wrap(async (req) => ({ job: await tickets.engineerJob(req.engineer, req.params.id) })));
  router.post('/jobs/:id/action', guard(), wrap(async (req) => {
    const out = await tickets.engineerAct(req.engineer, req.params.id, req.body || {});
    return out.declined ? out : { job: out };
  }));
  router.post('/jobs/:id/photo-upload', guard(), wrap((req) => tickets.engineerPhotoUpload(req.engineer, req.params.id, req.body || {})));
  router.post('/jobs/:id/photos', guard(), wrap(async (req) => ({ photo: await tickets.engineerAddPhoto(req.engineer, req.params.id, req.body || {}) })));

  // service report: the form (with the unit's readings filled in) and filing it
  if (reports) {
    router.get('/jobs/:id/report', guard(), wrap((req) => reports.form(req.engineer, req.params.id)));
    router.get('/jobs/:id/report-pdf', guard(), wrap((req) => reports.engineerPdf(req.engineer, req.params.id)));
    router.post('/jobs/:id/report', guard(), wrap((req) => reports.submit(req.engineer, req.params.id, req.body || {})));
  }

  // the phone registers its push-notification token here
  router.post('/device', guard(), wrap(async (req) => {
    const token = String((req.body || {}).token || '').slice(0, 300);
    if (token.length < 10) { const e = new Error('Invalid device token.'); e.status = 400; throw e; }
    await store.upsertDevice({ token, engineer_id: req.engineer.id, platform: String((req.body || {}).platform || '').slice(0, 20) || null });
    return { ok: true };
  }));

  // sign-out: this phone stops receiving this engineer's notifications
  router.delete('/device', guard(true), wrap(async (req) => {
    const token = String((req.body || {}).token || '').slice(0, 300);
    if (token.length >= 10) await store.deleteDevices([token]);
    return { ok: true };
  }));

  return router;
}

module.exports = { createEngineerAuth, createEngineerApiRouter, strongEnough };
