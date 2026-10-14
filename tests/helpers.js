'use strict';
// Shared fakes for the backend tests: an in-memory database, a fake clock, and a fake
// Supabase Auth admin. They implement the same methods as the real Supabase-backed store.
const assert = require('assert');
const crypto = require('crypto');

// ── in-memory store (same interface as supabaseStore) ──
function memStore(customers) {
  const counters = {};
  const tickets = [];
  const events = [];
  const engineers = [];
  const engineerEvents = [];
  const photos = [];
  const declines = [];
  const devices = [];
  let ev = 0;
  const copy = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);
  return {
    tickets, events,
    async nextSeq(series, start) {
      counters[series] = counters[series] == null ? start : counters[series] + 1;   // one counter, never resets
      return counters[series];
    },
    async getCustomer(id) { return copy(customers[id]) || null; },
    async insertTicket(row) {
      if (tickets.some(t => t.ticket_no === row.ticket_no)) throw new Error('duplicate ticket_no');
      const t = { id: `00000000-0000-4000-8000-${String(tickets.length + 1).padStart(12, '0')}`, ...copy(row) };
      tickets.push(t); return copy(t);
    },
    async getTicket(id) { return copy(tickets.find(t => t.id === id)) || null; },
    async updateTicketIfStatus(id, status, patch) {
      const t = tickets.find(x => x.id === id);
      if (!t || t.status !== status) return null;
      Object.assign(t, copy(patch)); return copy(t);
    },
    async listActive() { return copy(tickets.filter(t => !['closed', 'cancelled'].includes(t.status))); },
    async listClosed() { return copy(tickets.filter(t => ['closed', 'cancelled'].includes(t.status))); },
    async listByCustomer(cid, n) { return copy(tickets.filter(t => t.customer_id === cid).slice().reverse().slice(0, n)); },
    async insertEvent(e) { events.push({ id: ++ev, at: new Date().toISOString(), ...copy(e) }); },
    async listEvents(id) { return copy(events.filter(e => e.ticket_id === id)); },
    // ── engineers ──
    engineers, engineerEvents,
    async getEngineer(id) { return copy(engineers.find(e => e.id === id)) || null; },
    async findEngineerConflict(phone, proof, type) {
      return copy(engineers.find(e => e.phone === phone ||
        (e.id_proof_type === type && e.id_proof_ref.toLowerCase() === proof.toLowerCase()))) || null;
    },
    files: new Set(),
    async createSignedUpload(bucket, path) { return { path, token: 'upload-token' }; },
    async objectExists(bucket, path) { return this.files.has(path); },
    async signedReadUrl(bucket, path, secs) { return `https://signed.test/${bucket}/${path}?expires=${secs}`; },
    // ── photos, declines, devices ──
    photos, declines, devices,
    async insertPhoto(row) { const p = { id: `00000000-0000-4000-a000-${String(photos.length + 1).padStart(12, '0')}`, created_at: new Date().toISOString(), ...copy(row) }; photos.push(p); return copy(p); },
    async listPhotos(ticketId) { return copy(photos.filter(p => p.ticket_id === ticketId)); },
    async insertDecline(row) { if (!declines.some(d => d.ticket_id === row.ticket_id && d.engineer_id === row.engineer_id)) declines.push(copy(row)); },
    async listDeclinedTicketIds(engId) { return declines.filter(d => d.engineer_id === engId).map(d => d.ticket_id); },
    async listDevices(ids) { return copy(devices.filter(d => ids.includes(d.engineer_id))); },
    async deleteDevices(tokens) { for (const t of tokens) { const i = devices.findIndex(d => d.token === t); if (i >= 0) devices.splice(i, 1); } },
    async upsertDevice(row) { const i = devices.findIndex(d => d.token === row.token); if (i >= 0) devices[i] = copy(row); else devices.push(copy(row)); },
    async insertEngineer(row) {
      const e = { id: `00000000-0000-4000-9000-${String(engineers.length + 1).padStart(12, '0')}`, ...copy(row) };
      engineers.push(e); return copy(e);
    },
    async updateEngineer(id, patch) { const e = engineers.find(x => x.id === id); Object.assign(e, copy(patch)); return copy(e); },
    async listEngineers() { return copy(engineers); },
    async listActiveEngineers() { return copy(engineers.filter(e => e.status === 'active')); },
    async insertEngineerEvent(e) { engineerEvents.push(copy(e)); },
    async listEngineerEvents(id) { return copy(engineerEvents.filter(e => e.engineer_id === id)); },
  };
}


const CUST = '11111111-1111-4111-8111-111111111111';
const customers = {
  [CUST]: {
    id: CUST, name: 'Hotel Saffron', phone: '9999900000', address: 'Sector 14', city: 'Gurgaon',
    pincode: '122001', latitude: 28.45, longitude: 77.02, device_id: 'AQ-PR51916-32-001001',
    last_tds: 212, last_seen: '2026-10-13T05:00:00.000Z',
    sensor_data: { feed_tds: 480, output_flow: 1.1, reject_flow: 2.9, pump_current: 3.4 },
    connection_type: 'wifi', network_name: 'SiteWiFi', pump_baseline: 2.1, pump_status: 'weak',
  },
};
const ADMIN = { email: 'info@prtechno.in', role: 'owner' };

function clock(iso) {
  let t = new Date(iso);
  return { now: () => new Date(t), set: (i) => { t = new Date(i); }, add: (sec) => { t = new Date(t.getTime() + sec * 1000); } };
}
const ok400 = async (p, code, re) => {
  try { await p; } catch (e) { assert.strictEqual(e.status, code, `status ${e.status}: ${e.message}`); if (re) assert.match(e.message, re); return; }
  assert.fail('expected an error');
};


// Fake of the Supabase Auth admin used for engineer logins.
function fakeAccounts() {
  const users = new Map();     // userId -> { email, password, banned, must_change }
  const calls = [];
  return {
    users, calls,
    async createUser({ email, password, engineerId, engineerCode }) {
      const userId = crypto.randomUUID();
      users.set(userId, { email, password, banned: false, must_change: true, engineerId, engineerCode });
      calls.push(['createUser', email]); return { userId };
    },
    async setPassword(userId, password) { Object.assign(users.get(userId), { password, must_change: true }); calls.push(['setPassword']); },
    async changePassword(userId, password) { Object.assign(users.get(userId), { password, must_change: false }); calls.push(['changePassword']); },
    async setBanned(userId, banned) { users.get(userId).banned = banned; calls.push(['setBanned', banned]); },
    async deleteUser(userId) { users.delete(userId); calls.push(['deleteUser']); },
  };
}

module.exports = { memStore, clock, ok400, CUST, customers, ADMIN, fakeAccounts };
