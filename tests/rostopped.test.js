'use strict';
// Run:  node tests/rostopped.test.js
const assert = require('assert');
const R = require('../roStopped');

let passed = 0; const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + '  ->  ' + e.message]); }
}
// 11:00 IST = 05:30 UTC
const NOON = new Date('2026-10-24T06:30:00Z');             // 12:00 IST
const ago = (min, from = NOON) => new Date(from.getTime() - min * 60000).toISOString();
const base = { token: 'ExponentPushToken[x]', lastSeen: ago(1) };

(async () => {
  await test('decide: waits 10 minutes, then notifies once; never twice', async () => {
    assert.strictEqual(R.decide({ ...base, since: ago(3), now: NOON }), 'wait');
    assert.strictEqual(R.decide({ ...base, since: ago(12), now: NOON }), 'notify');
    assert.strictEqual(R.decide({ ...base, since: ago(12), notifiedAt: ago(1), now: NOON }), 'skip');
    assert.strictEqual(R.decide({ ...base, since: null, now: NOON }), 'skip');
  });
  await test('decide: a stop older than 90 minutes is closed silently; a silent (offline) device is not "stopped"', async () => {
    assert.strictEqual(R.decide({ ...base, since: ago(120), now: NOON }), 'expire');
    assert.strictEqual(R.decide({ ...base, lastSeen: ago(30), since: ago(15), now: NOON }), 'wait');
    assert.strictEqual(R.decide({ ...base, token: null, since: ago(15), now: NOON }), 'expire');
  });
  await test('decide: no notice at night (before 6 am / after 10 pm Indian time)', async () => {
    const night = new Date('2026-10-23T18:30:00Z');         // 00:00 IST
    assert.strictEqual(R.decide({ ...base, lastSeen: ago(1, night), since: ago(20, night), now: night }), 'wait');
    const late = new Date('2026-10-24T17:00:00Z');          // 22:30 IST
    assert.strictEqual(R.decide({ ...base, lastSeen: ago(1, late), since: ago(20, late), now: late }), 'wait');
    const morning = new Date('2026-10-24T01:00:00Z');       // 06:30 IST
    assert.strictEqual(R.decide({ ...base, lastSeen: ago(1, morning), since: ago(20, morning), now: morning }), 'notify');
  });

  const fakeSb = (rows, failUpdate) => ({
    from() { return { update(patch) { return { eq: async (col, id) => { if (failUpdate) return { error: { message: 'column does not exist' } }; Object.assign(rows.find(r => r.id === id), patch); return { error: null }; } }; } }; },
  });
  await test('tracker: marks when the pump first goes off, clears it when it runs again, ignores unknown status', async () => {
    const rows = [{ id: 'c1', pump_off_since: null }];
    const track = R.createTracker(fakeSb(rows), { now: () => NOON, log: { error() {} } });
    await track(rows[0], 'healthy');
    assert.strictEqual(rows[0].pump_off_since, null);
    await track(rows[0], 'OFF');
    assert.strictEqual(rows[0].pump_off_since, NOON.toISOString());
    const first = rows[0].pump_off_since;
    await track(rows[0], 'off');                              // still off: not changed
    assert.strictEqual(rows[0].pump_off_since, first);
    await track(rows[0], null);                               // no status in this reading: nothing happens
    assert.strictEqual(rows[0].pump_off_since, first);
    await track(rows[0], 'healthy');
    assert.strictEqual(rows[0].pump_off_since, null); assert.strictEqual(rows[0].pump_off_notified_at, null);
  });
  await test('tracker: a missing column pauses tracking quietly and never throws', async () => {
    const rows = [{ id: 'c1', pump_off_since: null }];
    let t = NOON.getTime();
    const track = R.createTracker(fakeSb(rows, true), { now: () => new Date(t), log: { error() {} } });
    assert.strictEqual(await track(rows[0], 'off'), null);
    t += 60 * 1000;
    assert.strictEqual(await track(rows[0], 'off'), null, 'paused for 10 minutes');
  });

  await test('runRoStopped: sends one push for a qualifying stop, marks it, and closes old ones silently', async () => {
    const rows = [
      { id: 'a', push_token: 'ExponentPushToken[a]', last_seen: ago(1), pump_off_since: ago(15), pump_off_notified_at: null },
      { id: 'b', push_token: 'ExponentPushToken[b]', last_seen: ago(1), pump_off_since: ago(3), pump_off_notified_at: null },
      { id: 'c', push_token: 'ExponentPushToken[c]', last_seen: ago(1), pump_off_since: ago(200), pump_off_notified_at: null },
    ];
    const marked = [];
    const store = { listPending: async () => rows, markNotified: async (id) => marked.push(id) };
    const pushes = [];
    const n = await R.runRoStopped({ store, send: async (tok, title, body, extra) => pushes.push({ tok, title, body, extra }), now: () => NOON, log: { error() {} } });
    assert.strictEqual(n, 1); assert.strictEqual(pushes.length, 1);
    assert.strictEqual(pushes[0].tok, 'ExponentPushToken[a]'); assert.strictEqual(pushes[0].title, 'Your RO has stopped');
    assert.match(pushes[0].body, /check if your tank is full/); assert.match(pushes[0].body, /raise a request with AQUIQ/);
    assert.strictEqual(pushes[0].extra.type, 'ro_stopped');
    assert.deepStrictEqual(marked.sort(), ['a', 'c'], 'a notified, c closed silently, b still waiting');
  });
  await test('runRoStopped: a failing push is retried next minute (not marked)', async () => {
    const rows = [{ id: 'a', push_token: 'ExponentPushToken[a]', last_seen: ago(1), pump_off_since: ago(15), pump_off_notified_at: null }];
    const marked = [];
    const store = { listPending: async () => rows, markNotified: async (id) => marked.push(id) };
    const n = await R.runRoStopped({ store, send: async () => { throw new Error('expo down'); }, now: () => NOON, log: { error() {} } });
    assert.strictEqual(n, 0); assert.deepStrictEqual(marked, []);
    assert.strictEqual(await R.runRoStopped({ store: { listPending: async () => { throw new Error('db'); } }, send: async () => {}, now: () => NOON, log: { error() {} } }), 0);
  });

  for (const [s, n] of results) console.log(`${s}  ${n}`);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})();
