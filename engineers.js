'use strict';
// AQUIQ registered engineers.
//
// Rules:
//  - Only a REGISTERED, ACTIVE engineer can be given a complaint (tickets.js enforces it).
//  - Registration is done by admin staff here. It needs a unique phone and a unique ID
//    document reference. Blocked rows are never deleted, so the same phone or the same
//    ID document can never register again.
//  - Coverage of a site: same pincode, OR within the engineer's radius (default 30 km)
//    when both the engineer and the site have a map position. "State-wide" engineers are
//    listed separately for admin to judge, because a site's state isn't stored.

const express = require('express');

const crypto = require('crypto');

const PROOF_BUCKET = 'engineer-docs';
const LOGIN_DOMAIN = 'engineers.prtechno.in';   // never receives mail; only gives each engineer a unique login name
const PROOF_TYPES = {
  driving_licence: 'Driving licence',
  aadhaar: 'Aadhaar card',
  pan: 'PAN card',
  other: 'Other',
};
const PROOF_MIMES = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
};
const PROOF_PATH_RE = /^engineers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9._-]{1,80}$/;
const PROOF_URL_SECONDS = 300;

const ENGINEER_SERIES = 'ENG';      // engineer IDs: ENG-1001, ENG-1002 ...
const ENGINEER_START = 1001;
const DEFAULT_RADIUS_KM = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}
function normPhone(v) {
  const d = String(v || '').replace(/\D/g, '');
  const t = d.length > 10 ? d.slice(-10) : d;
  return /^[6-9]\d{9}$/.test(t) ? t : null;          // Indian mobile
}
function normPincode(v) {
  const d = String(v || '').replace(/\D/g, '');
  return /^[1-9]\d{5}$/.test(d) ? d : null;
}
function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// How well does this engineer cover the site? null = does not.
function coverageOf(engineer, site) {
  if (engineer.pincode && site.pincode && engineer.pincode === site.pincode) {
    return { rank: 0, basis: 'pincode', label: 'Same pincode', km: null };
  }
  const has = (o) => o.latitude != null && o.longitude != null;
  if (has(engineer) && has(site)) {
    const km = haversineKm(engineer.latitude, engineer.longitude, site.latitude, site.longitude);
    if (km <= (engineer.radius_km || DEFAULT_RADIUS_KM)) {
      return { rank: 1, basis: 'distance', label: `${Math.round(km)} km away`, km };
    }
  }
  return null;
}

// Split the active engineers into who should be offered for a site.
function rankEngineers(site, engineers) {
  const recommended = [];
  const statewide = [];
  const others = [];
  for (const e of engineers) {
    if (e.status !== 'active') continue;
    const base = { id: e.id, engineer_code: e.engineer_code, name: e.name, phone: e.phone, pincode: e.pincode, city: e.city, state: e.state };
    const c = coverageOf(e, site);
    if (c) recommended.push({ ...base, basis: c.basis, label: c.label, km: c.km, rank: c.rank });
    else if (e.state_wide) statewide.push({ ...base, basis: 'state', label: `State-wide${e.state ? ' · ' + e.state : ''}` });
    else others.push({ ...base, basis: 'outside', label: 'Outside this area' });
  }
  recommended.sort((a, b) => a.rank - b.rank || (a.km ?? 0) - (b.km ?? 0) || a.name.localeCompare(b.name));
  statewide.sort((a, b) => a.name.localeCompare(b.name));
  others.sort((a, b) => a.name.localeCompare(b.name));
  return { recommended, statewide, others, matches: recommended.length };
}

function publicView(e) {
  return { ...e };   // admin-only API: includes ID reference
}

// Readable one-time password: no look-alike characters (0/O, 1/l/I). Always has a letter and a digit.
function generatePassword(len = 10) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = letters + digits;
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(letters), pick(digits)];
  while (chars.length < len) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {            // shuffle
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
const loginEmail = (code) => `${String(code).toLowerCase()}@${LOGIN_DOMAIN}`;

function createEngineerService(store, { now = () => new Date(), auth = null } = {}) {
  const needAuth = () => {
    if (!auth) throw httpError(501, 'Engineer logins need the server\'s Supabase service key to be set.');
    return auth;
  };

  const validate = (input, { partial = false } = {}) => {
    const out = {};
    const need = (cond, msg) => { if (!cond) throw httpError(400, msg); };

    if (!partial || input.name !== undefined) {
      out.name = cleanText(input.name, 120);
      need(out.name.length >= 2, 'Enter the engineer’s full name.');
    }
    if (!partial) {
      out.phone = normPhone(input.phone);
      need(out.phone, 'Enter a valid 10-digit mobile number.');
    }
    if (input.alt_phone !== undefined && cleanText(input.alt_phone, 20)) {
      out.alt_phone = normPhone(input.alt_phone);
      need(out.alt_phone, 'The alternate number is not a valid mobile number.');
    } else if (input.alt_phone !== undefined) {
      out.alt_phone = null;
    }
    if (!partial || input.pincode !== undefined) {
      out.pincode = normPincode(input.pincode);
      need(out.pincode, 'Enter the 6-digit pincode where the engineer is based.');
    }
    if (!partial) {
      out.id_proof_type = String(input.id_proof_type || '');
      need(PROOF_TYPES[out.id_proof_type], 'Choose the ID document: Driving licence, Aadhaar card, PAN card or Other.');
      out.id_proof_other = null;
      if (out.id_proof_type === 'other') {
        out.id_proof_other = cleanText(input.id_proof_other, 60);
        need(out.id_proof_other.length >= 2, 'You chose Other. Write the name of the document.');
      }
      out.id_proof_ref = cleanText(input.id_proof_ref, 60);
      need(out.id_proof_ref.length >= 4, 'Enter the document number (needed so a blocked person cannot register again).');
      if (input.proof_path) {
        out.proof_path = String(input.proof_path);
        need(PROOF_PATH_RE.test(out.proof_path), 'The attached file reference is not valid. Attach it again.');
        out.proof_file_name = cleanText(input.proof_file_name, 120) || null;
        out.proof_mime = PROOF_MIMES[input.proof_mime] ? input.proof_mime : null;
      }
    }
    for (const k of ['address', 'city', 'state']) {
      if (input[k] !== undefined) out[k] = cleanText(input[k], k === 'address' ? 250 : 80) || null;
    }
    if (input.latitude !== undefined || input.longitude !== undefined) {
      const lat = numOrNull(input.latitude);
      const lng = numOrNull(input.longitude);
      if (lat == null && lng == null) { out.latitude = null; out.longitude = null; }
      else {
        need(lat != null && lng != null, 'Give both latitude and longitude, or neither.');
        need(lat >= 6 && lat <= 38 && lng >= 68 && lng <= 98, 'That map position is not inside India.');
        out.latitude = lat; out.longitude = lng;
      }
    }
    if (input.radius_km !== undefined) {
      const r = Math.round(Number(input.radius_km));
      need(Number.isFinite(r) && r >= 1 && r <= 300, 'Coverage radius must be between 1 and 300 km.');
      out.radius_km = r;
    }
    if (input.state_wide !== undefined) out.state_wide = !!input.state_wide;
    if (input.designation !== undefined) out.designation = cleanText(input.designation, 60) || null;
    return out;
  };

  async function register(input, actor) {
    const v = validate(input || {});

    if (v.proof_path && !(await store.objectExists(PROOF_BUCKET, v.proof_path))) {
      throw httpError(400, 'The attached file was not found. Attach it again.');
    }
    const clash = await store.findEngineerConflict(v.phone, v.id_proof_ref, v.id_proof_type);
    if (clash) {
      const field = clash.phone === v.phone ? 'phone number' : 'ID document';
      throw httpError(409, clash.status === 'blocked'
        ? `This ${field} belongs to a BLOCKED engineer (${clash.engineer_code}). They cannot be registered again.`
        : `This ${field} is already registered to ${clash.name} (${clash.engineer_code}).`);
    }

    const seq = await store.nextSeq(ENGINEER_SERIES, ENGINEER_START);
    const at = now().toISOString();
    const code = `${ENGINEER_SERIES}-${seq}`;
    const engineerId = crypto.randomUUID();

    // Create the login first; if saving the record then fails, the login is removed again.
    let authUserId = null;
    let password = null;
    if (auth) {
      password = generatePassword();
      const made = await auth.createUser({ email: loginEmail(code), password, engineerId, engineerCode: code });
      authUserId = made.userId;
    }
    let row;
    try {
      row = await store.insertEngineer({
      id: engineerId, auth_user_id: authUserId,
      engineer_code: code,
      name: v.name, phone: v.phone, alt_phone: v.alt_phone ?? null,
      address: v.address ?? null, city: v.city ?? null, state: v.state ?? null,
      pincode: v.pincode, latitude: v.latitude ?? null, longitude: v.longitude ?? null,
      radius_km: v.radius_km ?? DEFAULT_RADIUS_KM, state_wide: v.state_wide ?? false,
      designation: v.designation ?? null,
      id_proof_type: v.id_proof_type, id_proof_other: v.id_proof_other, id_proof_ref: v.id_proof_ref,
      proof_path: v.proof_path ?? null, proof_file_name: v.proof_file_name ?? null, proof_mime: v.proof_mime ?? null,
      proof_uploaded_at: v.proof_path ? at : null,
      status: 'active',
      registered_by: actor.email, created_at: at, updated_at: at,
      });
    } catch (err) {
      if (authUserId) { try { await auth.deleteUser(authUserId); } catch { /* best effort */ } }
      throw err;
    }
    await store.insertEngineerEvent({
      engineer_id: row.id, actor: actor.email, actor_role: actor.role,
      action: 'registered', note: null,
      meta: { engineer_code: row.engineer_code, proof_attached: !!v.proof_path, login_created: !!authUserId },
    });
    // The password is returned ONCE here and never stored in readable form.
    return { ...publicView(row), initial_password: password };
  }

  // Issue (or re-issue) a login password. Also creates the login for an engineer
  // registered before logins existed. The password is shown once and never kept.
  async function issuePassword(id, actor) {
    if (!UUID_RE.test(String(id))) throw httpError(400, 'Invalid engineer.');
    const a = needAuth();
    const e = await store.getEngineer(id);
    if (!e) throw httpError(404, 'Engineer not found.');
    if (e.status !== 'active') throw httpError(409, 'This engineer is blocked. Restore access first.');
    const password = generatePassword();
    let created = false;
    if (e.auth_user_id) {
      await a.setPassword(e.auth_user_id, password);
    } else {
      const made = await a.createUser({ email: loginEmail(e.engineer_code), password, engineerId: e.id, engineerCode: e.engineer_code });
      await store.updateEngineer(id, { auth_user_id: made.userId, updated_at: now().toISOString() });
      created = true;
    }
    await store.insertEngineerEvent({
      engineer_id: id, actor: actor.email, actor_role: actor.role,
      action: 'password_issued', note: null, meta: { login_created: created },
    });
    return { engineer_code: e.engineer_code, name: e.name, password };
  }

  async function list(filter) {
    const rows = await store.listEngineers();
    const f = filter === 'blocked' || filter === 'all' ? filter : 'active';
    return rows
      .filter(e => f === 'all' || e.status === f)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(publicView);
  }

  async function detail(id) {
    if (!UUID_RE.test(String(id))) throw httpError(400, 'Invalid engineer.');
    const e = await store.getEngineer(id);
    if (!e) throw httpError(404, 'Engineer not found.');
    return { engineer: publicView(e), events: await store.listEngineerEvents(id) };
  }

  async function setStatus(id, status, text, actor) {
    if (!UUID_RE.test(String(id))) throw httpError(400, 'Invalid engineer.');
    const note = cleanText(text, 500);
    if (status === 'blocked' && !note) throw httpError(400, 'A reason is required to block an engineer.');
    const e = await store.getEngineer(id);
    if (!e) throw httpError(404, 'Engineer not found.');
    if (e.status === status) throw httpError(409, `Already ${status}.`);
    const at = now().toISOString();
    const patch = status === 'blocked'
      ? { status, blocked_reason: note, blocked_at: at, blocked_by: actor.email, updated_at: at }
      : { status, blocked_reason: null, blocked_at: null, blocked_by: null, updated_at: at };
    const updated = await store.updateEngineer(id, patch);
    // The engineer API also checks this status on every request; ending the login is a second lock.
    if (auth && e.auth_user_id) {
      try { await auth.setBanned(e.auth_user_id, status === 'blocked'); } catch (err) { console.error('[ENGINEERS] ban:', err.message); }
    }
    await store.insertEngineerEvent({
      engineer_id: id, actor: actor.email, actor_role: actor.role,
      action: status === 'blocked' ? 'blocked' : 'restored', note: note || null, meta: null,
    });
    return publicView(updated);
  }

  async function update(id, input, actor) {
    if (!UUID_RE.test(String(id))) throw httpError(400, 'Invalid engineer.');
    const e = await store.getEngineer(id);
    if (!e) throw httpError(404, 'Engineer not found.');
    const v = validate(input || {}, { partial: true });
    delete v.phone; delete v.id_proof_ref; delete v.id_proof_type; delete v.id_proof_other;   // identity fields are never edited
    if (!Object.keys(v).length) throw httpError(400, 'Nothing to change.');
    const updated = await store.updateEngineer(id, { ...v, updated_at: now().toISOString() });
    await store.insertEngineerEvent({
      engineer_id: id, actor: actor.email, actor_role: actor.role,
      action: 'updated', note: null, meta: { fields: Object.keys(v) },
    });
    return publicView(updated);
  }

  // 1) the admin panel asks for a one-time upload slot, 2) uploads the file straight to
  // private storage, 3) sends the returned path with the registration (or attaches it later).
  async function createProofUpload(input) {
    const mime = String(input.content_type || '');
    if (!PROOF_MIMES[mime]) throw httpError(400, 'Attach a JPG, PNG or WebP photo, or a PDF.');
    const base = cleanText(input.filename, 80).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'proof';
    const path = `engineers/${crypto.randomUUID()}/${base}.${PROOF_MIMES[mime]}`;
    const slot = await store.createSignedUpload(PROOF_BUCKET, path);
    return { path, token: slot.token, bucket: PROOF_BUCKET, max_bytes: 5 * 1024 * 1024 };
  }

  async function attachProof(id, input, actor) {
    if (!UUID_RE.test(String(id))) throw httpError(400, 'Invalid engineer.');
    const e = await store.getEngineer(id);
    if (!e) throw httpError(404, 'Engineer not found.');
    const path = String(input.proof_path || '');
    if (!PROOF_PATH_RE.test(path)) throw httpError(400, 'The attached file reference is not valid. Attach it again.');
    if (!(await store.objectExists(PROOF_BUCKET, path))) throw httpError(400, 'The attached file was not found. Attach it again.');
    const at = now().toISOString();
    const updated = await store.updateEngineer(id, {
      proof_path: path, proof_file_name: cleanText(input.proof_file_name, 120) || null,
      proof_mime: PROOF_MIMES[input.proof_mime] ? input.proof_mime : null,
      proof_uploaded_at: at, updated_at: at,
    });
    await store.insertEngineerEvent({
      engineer_id: id, actor: actor.email, actor_role: actor.role,
      action: 'proof_attached', note: null, meta: { replaced: !!e.proof_path },
    });
    return publicView(updated);
  }

  // A short-lived private link. Every look at an ID document is written to the history.
  async function proofUrl(id, actor) {
    if (!UUID_RE.test(String(id))) throw httpError(400, 'Invalid engineer.');
    const e = await store.getEngineer(id);
    if (!e) throw httpError(404, 'Engineer not found.');
    if (!e.proof_path) throw httpError(404, 'No proof is attached for this engineer.');
    const url = await store.signedReadUrl(PROOF_BUCKET, e.proof_path, PROOF_URL_SECONDS);
    await store.insertEngineerEvent({
      engineer_id: id, actor: actor.email, actor_role: actor.role,
      action: 'proof_viewed', note: null, meta: null,
    });
    return { url, expires_in: PROOF_URL_SECONDS, file_name: e.proof_file_name, mime: e.proof_mime };
  }

  return {
    register, list, detail, update, createProofUpload, attachProof, proofUrl, issuePassword,
    block: (id, reason, actor) => setStatus(id, 'blocked', reason, actor),
    restore: (id, note, actor) => setStatus(id, 'active', note, actor),
  };
}

// ── Supabase-backed store (merged with the tickets store in server.js) ──────

function supabaseEngineerStore(sb) {
  const fail = (error) => {
    const missing = error && ['42P01', 'PGRST205'].includes(error.code);
    const e = httpError(missing ? 503 : 500,
      missing ? 'Engineers are not set up yet. Run the engineers SQL in Supabase first.' : 'Database error.');
    e.detail = error && error.message;
    return e;
  };
  const one = async (q) => { const { data, error } = await q; if (error) throw fail(error); return data; };

  return {
    getEngineer: (id) => one(sb.from('engineers').select('*').eq('id', id).maybeSingle()),
    async findEngineerConflict(phone, idProof, idType) {
      const byPhone = await one(sb.from('engineers').select('*').eq('phone', phone).maybeSingle());
      if (byPhone) return byPhone;
      return one(sb.from('engineers').select('*').eq('id_proof_type', idType)
        .ilike('id_proof_ref', idProof.replace(/[%_]/g, '\\$&')).maybeSingle());
    },
    async createSignedUpload(bucket, path) {
      const { data, error } = await sb.storage.from(bucket).createSignedUploadUrl(path);
      if (error) throw fail(error);
      return data;
    },
    async objectExists(bucket, path) {
      const i = path.lastIndexOf('/');
      const { data, error } = await sb.storage.from(bucket).list(path.slice(0, i), { search: path.slice(i + 1), limit: 5 });
      if (error) throw fail(error);
      return (data || []).some(f => f.name === path.slice(i + 1));
    },
    async signedReadUrl(bucket, path, seconds) {
      const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, seconds);
      if (error) throw fail(error);
      return data.signedUrl;
    },
    insertEngineer: (row) => one(sb.from('engineers').insert([row]).select().single()),
    updateEngineer: (id, patch) => one(sb.from('engineers').update(patch).eq('id', id).select().single()),
    listEngineers: () => one(sb.from('engineers').select('*').order('name', { ascending: true }).limit(1000)),
    listActiveEngineers: () => one(sb.from('engineers').select('*').eq('status', 'active').limit(1000)),
    async insertEngineerEvent(e) { await one(sb.from('engineer_events').insert([e])); },
    async upsertDevice(row) {
      await one(sb.from('engineer_devices').upsert([{ ...row, updated_at: new Date().toISOString() }], { onConflict: 'token' }));
    },
    listEngineerEvents: (id) => one(sb.from('engineer_events').select('*').eq('engineer_id', id).order('at', { ascending: true })),
  };
}

// ── Supabase Auth adapter: one login per engineer (needs the service key) ───

function supabaseEngineerAuth(sb) {
  const must = (error, what) => { if (error) { const e = httpError(500, `Could not ${what}.`); e.detail = error.message; throw e; } };
  const merged = async (userId, extra) => {
    const { data, error } = await sb.auth.admin.getUserById(userId);
    must(error, 'read the engineer login');
    return { ...(data.user.app_metadata || {}), ...extra };
  };
  return {
    async createUser({ email, password, engineerId, engineerCode }) {
      const { data, error } = await sb.auth.admin.createUser({
        email, password, email_confirm: true,
        app_metadata: { role: 'engineer', engineer_id: engineerId, engineer_code: engineerCode, must_change_password: true },
      });
      must(error, 'create the engineer login');
      return { userId: data.user.id };
    },
    async setPassword(userId, password) {
      const { error } = await sb.auth.admin.updateUserById(userId, {
        password, app_metadata: await merged(userId, { must_change_password: true }),
      });
      must(error, 'set the password');
    },
    async changePassword(userId, password) {          // the engineer's own new password
      const { error } = await sb.auth.admin.updateUserById(userId, {
        password, app_metadata: await merged(userId, { must_change_password: false }),
      });
      must(error, 'change the password');
    },
    async setBanned(userId, banned) {
      const { error } = await sb.auth.admin.updateUserById(userId, { ban_duration: banned ? '876000h' : 'none' });
      must(error, banned ? 'end the engineer login' : 'restore the engineer login');
    },
    async deleteUser(userId) {
      const { error } = await sb.auth.admin.deleteUser(userId);
      must(error, 'remove the engineer login');
    },
  };
}

// ── HTTP layer ───────────────────────────────────────────────────────────────

function createEngineersRouter(service) {
  const router = express.Router();
  const actorOf = (req) => ({
    email: (req.admin && req.admin.email) || 'unknown',
    role: (req.admin && req.admin.role) || 'unknown',
  });
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      if (!err.status || err.status >= 500) console.error('[ENGINEERS]', err.message, err.detail || '');
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong.' });
    }
  };

  router.get('/', wrap(async (req) => ({ engineers: await service.list(req.query.filter) })));
  router.post('/', wrap(async (req) => {
    const { initial_password, ...engineer } = await service.register(req.body || {}, actorOf(req));
    return { engineer, initial_password };
  }));
  router.post('/proof-upload', wrap((req) => service.createProofUpload(req.body || {})));
  router.get('/:id', wrap((req) => service.detail(req.params.id)));
  router.get('/:id/proof-url', wrap((req) => service.proofUrl(req.params.id, actorOf(req))));
  router.post('/:id/proof', wrap(async (req) => ({ engineer: await service.attachProof(req.params.id, req.body || {}, actorOf(req)) })));
  router.post('/:id/block', wrap(async (req) => ({ engineer: await service.block(req.params.id, (req.body || {}).reason, actorOf(req)) })));
  router.post('/:id/restore', wrap(async (req) => ({ engineer: await service.restore(req.params.id, (req.body || {}).note, actorOf(req)) })));
  router.post('/:id/password', wrap((req) => service.issuePassword(req.params.id, actorOf(req))));
  router.post('/:id/update', wrap(async (req) => ({ engineer: await service.update(req.params.id, req.body || {}, actorOf(req)) })));
  return router;
}

module.exports = {
  ENGINEER_SERIES, ENGINEER_START, DEFAULT_RADIUS_KM, PROOF_TYPES, PROOF_MIMES,
  coverageOf, rankEngineers, haversineKm, normPhone, normPincode, generatePassword, loginEmail, publicView,
  supabaseEngineerAuth, PROOF_BUCKET,
  createEngineerService, supabaseEngineerStore, createEngineersRouter,
};
