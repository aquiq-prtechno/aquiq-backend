'use strict';
// "Your RO has stopped": when the pump goes OFF, wait a few minutes, then tell the customer once, in plain words.
// Most often a stopped RO simply means the tank is full (the RO then restarts by itself), so the message asks the
// customer to check the tank first and offers a service request only if it is not full.
//   - never at night (before 6 am / after 10 pm IST), never hours later, never if the device itself is offline,
//   - at most once per stop (the marker is cleared as soon as the pump runs again).

const WAIT_MIN = 10;         // pump must stay off this long
const MAX_AGE_MIN = 90;      // after this the moment has passed: close it silently
const DAY_FROM = 6;          // IST hours in which a notice may be sent
const DAY_TO = 22;
const ONLINE_MS = 5 * 60 * 1000;

const MESSAGE = {
  title: 'Your RO has stopped',
  body: 'Please check if your tank is full. If it is, the RO starts again by itself when water is used. If the tank is not full, open the app and raise a request with AQUIQ.',
};

function istHour(now) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(now)) % 24;
}

// -> 'skip' | 'wait' | 'expire' (close silently) | 'notify'
function decide({ since, notifiedAt, lastSeen, token, now = new Date() }) {
  if (!since || notifiedAt) return 'skip';
  const ageMin = (now.getTime() - new Date(since).getTime()) / 60000;
  if (ageMin > MAX_AGE_MIN) return 'expire';
  if (ageMin < WAIT_MIN) return 'wait';
  const online = lastSeen && now.getTime() - new Date(lastSeen).getTime() < ONLINE_MS;
  if (!online) return 'wait';                       // the device is silent: that is "offline", not "stopped"
  const h = istHour(now);
  if (h < DAY_FROM || h >= DAY_TO) return 'wait';
  if (!token) return 'expire';                      // nobody to tell
  return 'notify';
}

// Called for every reading from a device. Marks when the pump first went off, clears it when it runs again.
// Never throws, and never touches the main reading update, so a missing column cannot break device data.
function createTracker(sb, { now = () => new Date(), log = console } = {}) {
  let pausedUntil = 0;
  return async function track(customer, pumpStatus) {
    try {
      const status = String(pumpStatus || '').trim().toLowerCase();
      if (!status || now().getTime() < pausedUntil) return null;
      const off = status === 'off';
      let patch = null;
      if (off && !customer.pump_off_since) patch = { pump_off_since: now().toISOString(), pump_off_notified_at: null };
      else if (!off && customer.pump_off_since) patch = { pump_off_since: null, pump_off_notified_at: null };
      if (!patch) return null;
      const { error } = await sb.from('customers').update(patch).eq('id', customer.id);
      if (error) { pausedUntil = now().getTime() + 10 * 60 * 1000; log.error('[RO-STOP] tracking paused (run migration 2026-10-24_ro_stopped.sql?):', error.message); return null; }
      return patch;
    } catch (e) { log.error('[RO-STOP] track:', e.message); return null; }
  };
}

// Every minute: send the notice for stops that have lasted long enough.
async function runRoStopped({ store, send, now = () => new Date(), log = console }) {
  let sent = 0;
  let rows = [];
  try { rows = await store.listPending(); } catch (e) { log.error('[RO-STOP] list:', e.message); return 0; }
  for (const c of rows) {
    const verdict = decide({ since: c.pump_off_since, notifiedAt: c.pump_off_notified_at, lastSeen: c.last_seen, token: c.push_token, now: now() });
    if (verdict === 'notify') {
      try { await send(c.push_token, MESSAGE.title, MESSAGE.body, { type: 'ro_stopped', store_id: c.id }); sent += 1; }
      catch (e) { log.error('[RO-STOP] push:', e.message); continue; }       // try again next minute
      await store.markNotified(c.id, now().toISOString()).catch(() => {});
    } else if (verdict === 'expire') {
      await store.markNotified(c.id, now().toISOString()).catch(() => {});
    }
  }
  return sent;
}

function supabaseStore(sb) {
  return {
    async listPending() {
      const { data, error } = await sb.from('customers')
        .select('id,push_token,last_seen,pump_off_since,pump_off_notified_at')
        .not('pump_off_since', 'is', null).is('pump_off_notified_at', null).limit(500);
      if (error) throw new Error(error.message);
      return data || [];
    },
    async markNotified(id, iso) { await sb.from('customers').update({ pump_off_notified_at: iso }).eq('id', id); },
  };
}

module.exports = { decide, createTracker, runRoStopped, supabaseStore, MESSAGE, WAIT_MIN, MAX_AGE_MIN };
