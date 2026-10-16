'use strict';
// Admin "All Accounts": every company account (UHAD) and store (UHSA) with its login, contact
// details and status. Passwords are never shown; an admin can set a NEW password, which is
// displayed once.

const express = require('express');
const { generatePassword } = require('./engineers');
const { hashPassword, strongEnough } = require('./passwords');
const { isOld, LATEST } = require('./versions');

const ONLINE_MS = 10 * 60 * 1000;
const httpError = (status, message) => { const e = new Error(message); e.status = status; return e; };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createAccountsService(store, { now = () => new Date() } = {}) {
  const state = (row) => (row.account_status === 'removed' ? 'Removed' : row.account_status === 'suspended' ? 'Suspended' : 'Active');

  async function list() {
    const [uhads, stores] = await Promise.all([store.listUhads(), store.listStores()]);
    const at = now().getTime();
    const byUhad = new Map();
    for (const s of stores) { if (!byUhad.has(s.uhad_id)) byUhad.set(s.uhad_id, []); byUhad.get(s.uhad_id).push(s); }
    const running = (s) => !!(s.last_seen && at - new Date(s.last_seen).getTime() <= ONLINE_MS);
    const rows = [];
    for (const u of uhads) {
      const mine = byUhad.get(u.id) || [];
      rows.push({
        type: 'UHAD', id: u.id, name: u.name, company: u.company,
        login: [u.email, u.phone].filter(Boolean).join('  ·  ') || '—',
        phone: u.phone || null, email: u.email || null, status: state(u), has_password: !!u.has_password,
        stores: mine.length, running: mine.filter(running).length, last_seen: null, created_at: u.created_at,
        app_version: u.app_version || null, app_seen_at: u.app_seen_at || null, app_old: isOld(u.app_version, 'customer'),
      });
    }
    for (const s of stores) {
      const owner = uhads.find(u => u.id === s.uhad_id);
      rows.push({
        type: 'UHSA', id: s.id, name: s.name, company: owner ? owner.company : '—', login: s.phone || '—',
        phone: s.phone || null, email: s.email || null, status: state(s), has_password: false,
        stores: null, running: running(s) ? 1 : 0, last_seen: s.last_seen || null, device_id: s.device_id || null,
        created_at: s.created_at,
        app_version: s.app_version || null, app_seen_at: s.app_seen_at || null, app_old: isOld(s.app_version, 'customer'),
      });
    }
    return { accounts: rows, latest_version: LATEST.customer, at: new Date(at).toISOString() };
  }

  async function newPassword(uhadId, actor, chosen) {
    if (!UUID_RE.test(String(uhadId))) throw httpError(400, 'Invalid account.');
    const u = await store.getUhad(uhadId);
    if (!u) throw httpError(404, 'Account not found.');
    let password = chosen ? String(chosen) : generatePassword(10);
    if (chosen && !strongEnough(password)) throw httpError(400, 'Use at least 8 characters, with letters and numbers.');
    await store.setUhadPassword(uhadId, hashPassword(password));
    return { company: u.company, name: u.name, login_email: u.email || null, login_phone: u.phone || null, password, by: actor };
  }

  return { list, newPassword };
}

function createAccountsRouter(service) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (err) {
      if (!err.status || err.status >= 500) console.error('[ACCOUNTS]', err.message, err.detail || '');
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong.' });
    }
  };
  router.get('/', wrap(() => service.list()));
  router.post('/uhad/:id/password', wrap(async (req) => {
    const out = await service.newPassword(req.params.id, (req.admin && req.admin.email) || 'admin', (req.body || {}).password);
    console.log(`[ACCOUNTS] ${out.by} set a new password for UHAD ${req.params.id}`);
    delete out.by;
    return out;
  }));
  return router;
}

function supabaseAccountsStore(sb) {
  const one = async (q) => { const { data, error } = await q; if (error) { const e = httpError(500, 'Database error.'); e.detail = error.message; throw e; } return data; };
  return {
    async listUhads() {
      // the password column is read only to say whether one exists; it never leaves this function
      const rows = await one(sb.from('uhads').select('*').order('company'));
      return rows.map(({ password, password_hash, ...r }) => ({ ...r, has_password: !!(password || password_hash) }));
    },
    listStores: () => one(sb.from('customers').select('*').eq('role', 'uhsa').order('name')),
    getUhad: (id) => one(sb.from('uhads').select('id,name,company,email,phone').eq('id', id).maybeSingle()),
    // only a hash is stored; the plain-text column is emptied
    async setUhadPassword(id, passwordHash) { await one(sb.from('uhads').update({ password_hash: passwordHash, password: null }).eq('id', id)); },
  };
}

module.exports = { createAccountsService, createAccountsRouter, supabaseAccountsStore };
