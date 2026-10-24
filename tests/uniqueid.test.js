'use strict';
// Run:  node tests/uniqueid.test.js
const assert = require('assert');
const U = require('../uniqueId');
const { deviceReadings, renderPdf } = require('../reports');

let passed = 0; const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + '  ->  ' + e.message]); }
}
const NOW = new Date('2026-10-24T06:30:00Z');
const ago = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
const dev = { wifi_device_id: '51916-AQ-PR-78:3B:01', last_seen: ago(1) };

(async () => {
  await test('compact format has no hyphens or colons', () => assert.strictEqual(U.compact('51916-AQ-PR-78:3b:01'), '51916AQPR783B01'));
  await test('shown while powered on', () => assert.strictEqual(U.forStaff(dev, NOW), '51916AQPR783B01'));
  await test('hidden when the device is not powered on (no data for 6 min)', () => assert.strictEqual(U.forStaff({ ...dev, last_seen: ago(6) }, NOW), null));
  await test('hidden when the store has no AQUIQ device ID', () => assert.strictEqual(U.forStaff({ last_seen: ago(1) }, NOW), null));
  await test('hidden when never seen', () => assert.strictEqual(U.forStaff({ wifi_device_id: dev.wifi_device_id }, NOW), null));
  await test('report readings carry the unique id only when powered on', () => {
    assert.strictEqual(deviceReadings(dev, NOW).unique_id, '51916AQPR783B01');
    assert.strictEqual(deviceReadings({ ...dev, last_seen: ago(60) }, NOW).unique_id, null);
  });
  await test('PDF renders with and without a unique id', async () => {
    const base = { report_no: 'FSR-PMR1', ticket_no: 'PMR1', when_label: '24 Oct, 12:00 pm', data: {}, device_readings: deviceReadings(dev, NOW) };
    const a = await renderPdf(base, []);
    const b = await renderPdf({ ...base, device_readings: deviceReadings({}, NOW) }, []);
    assert.ok(a.length > 1000 && b.length > 1000);
  });
  for (const [s, n] of results) console.log(`${s}  ${n}`);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})();
