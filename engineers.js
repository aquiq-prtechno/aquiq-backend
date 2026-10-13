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

function createEngineerService(store, { now = () => new Date() } = {}) {
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
      out.id_proof_ref = cleanText(input.id_proof_ref, 60);
      need(out.id_proof_ref.length >= 4, 'Enter the ID document reference (needed so a blocked person cannot register again).');
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
    return out;
  };

  async function register(input, actor) {
    const v = validate(input || {});

    const clash = await store.findEngineerConflict(v.phone, v.id_proof_ref);
    if (clash) {
      const field = clash.phone === v.phone ? 'phone number' : 'ID document';
      throw httpError(409, clash.status === 'blocked'
        ? `This ${field} belongs to a BLOCKED engineer (${clash.engineer_code}). They cannot be registered again.`
        : `This ${field} is already registered to ${clash.name} (${clash.engineer_code}).`);
    }

    const seq = await store.nextSeq(ENGINEER_SERIES, ENGINEER_START);
    const at = now().toISOString();
    const row = await store.insertEngineer({
      engineer_code: `${ENGINEER_SERIES}-${seq}`,
      name: v.name, phone: v.phone, alt_phone: v.alt_phone ?? null,
      address: v.address ?? null, city: v.city ?? null, state: v.state ?? null,
      pincode: v.pincode, latitude: v.latitude ?? null, longitude: v.longitude ?? null,
      radius_km: v.radius_km ?? DEFAULT_RADIUS_KM, state_wide: v.state_wide ?? false,
      id_proof_ref: v.id_proof_ref, status: 'active',
      registered_by: actor.email, created_at: at, updated_at: at,
    });
    await store.insertEngineerEvent({
      engineer_id: row.id, actor: actor.email, actor_role: actor.role,
      action: 'registered', note: null, meta: { engineer_code: row.engineer_code },
    });
    return publicView(row);
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
    delete v.phone; delete v.id_proof_ref;            // identity fields are never edited
    if (!Object.keys(v).length) throw httpError(400, 'Nothing to change.');
    const updated = await store.updateEngineer(id, { ...v, updated_at: now().toISOString() });
    await store.insertEngineerEvent({
      engineer_id: id, actor: actor.email, actor_role: actor.role,
      action: 'updated', note: null, meta: { fields: Object.keys(v) },
    });
    return publicView(updated);
  }

  return {
    register, list, detail, update,
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
    async findEngineerConflict(phone, idProof) {
      const byPhone = await one(sb.from('engineers').select('*').eq('phone', phone).maybeSingle());
      if (byPhone) return byPhone;
      return one(sb.from('engineers').select('*').ilike('id_proof_ref', idProof.replace(/[%_]/g, '\\$&')).maybeSingle());
    },
    insertEngineer: (row) => one(sb.from('engineers').insert([row]).select().single()),
    updateEngineer: (id, patch) => one(sb.from('engineers').update(patch).eq('id', id).select().single()),
    listEngineers: () => one(sb.from('engineers').select('*').order('name', { ascending: true }).limit(1000)),
    listActiveEngineers: () => one(sb.from('engineers').select('*').eq('status', 'active').limit(1000)),
    async insertEngineerEvent(e) { await one(sb.from('engineer_events').insert([e])); },
    listEngineerEvents: (id) => one(sb.from('engineer_events').select('*').eq('engineer_id', id).order('at', { ascending: true })),
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
  router.post('/', wrap(async (req) => ({ engineer: await service.register(req.body || {}, actorOf(req)) })));
  router.get('/:id', wrap((req) => service.detail(req.params.id)));
  router.post('/:id/block', wrap(async (req) => ({ engineer: await service.block(req.params.id, (req.body || {}).reason, actorOf(req)) })));
  router.post('/:id/restore', wrap(async (req) => ({ engineer: await service.restore(req.params.id, (req.body || {}).note, actorOf(req)) })));
  router.post('/:id/update', wrap(async (req) => ({ engineer: await service.update(req.params.id, req.body || {}, actorOf(req)) })));
  return router;
}

module.exports = {
  ENGINEER_SERIES, ENGINEER_START, DEFAULT_RADIUS_KM,
  coverageOf, rankEngineers, haversineKm, normPhone, normPincode,
  createEngineerService, supabaseEngineerStore, createEngineersRouter,
};
