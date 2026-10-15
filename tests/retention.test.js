'use strict';
// Run:  node tests/retention.test.js
// 12-month clean-up, rebuilt PDFs, signed links, visit log exports with the AQUIQ letterhead.
const assert = require('assert');
const T = require('../tickets');
const E = require('../engineers');
const R = require('../reports');
const C = require('../customerApi');
const L = require('../fileLinks');
const V = require('../visitLog');
const { runRetention } = require('../retention');
const { memStore, clock, ok400, CUST, customers, ADMIN, fakeAccounts } = require('./helpers');

let passed = 0; const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + '  ->  ' + e.message + (e.stack ? '\n' + e.stack.split('\n')[1] : '')]); }
}
const PHOTO = (id, n) => `jobs/${id}/0000000${n}-0000-4000-8000-000000000000.jpg`;
const FORM = { overall_status: 'Completed', capacity: '100/150 LPH', tds_status: 'NO ISSUE (USER)', load: 'No Fluctuation', remarks: 'Changed filter' };

function world() {
  const c = clock('2026-10-14T06:00:00Z');
  const store = memStore(customers);
  const rows = []; const objects = {};
  store.getReportByTicket = async (id) => JSON.parse(JSON.stringify(rows.find(r => r.ticket_id === id) || null));
  store.insertReport = async (row) => { const r = { id: `r${rows.length + 1}`, ...JSON.parse(JSON.stringify(row)) }; rows.push(r); return r; };
  store.updateReport = async (id, patch) => { Object.assign(rows.find(r => r.id === id), patch); };
  store.deleteReport = async (id) => { rows.splice(rows.findIndex(r => r.id === id), 1); };
  store.uploadObject = async (b, p, buf) => { objects[`${b}/${p}`] = buf; };
  store.getCustomerEmail = async () => null;
  store.listReportsDue = async (cutoff) => rows.filter(r => r.created_at < cutoff && !r.media_purged_at);
  store.deleteObjects = async (b, paths) => { for (const p of paths) delete objects[`${b}/${p}`]; };
  store.deletePhotoRows = async (tid) => { const ph = store.photos; for (let i = ph.length - 1; i >= 0; i--) if (ph[i].ticket_id === tid) ph.splice(i, 1); };
  store.manual = [];
  store.listServiceHistory = async () => store.manual;
  const ts = T.createTicketService(store, { now: c.now });
  const es = E.createEngineerService(store, { now: c.now, auth: fakeAccounts() });
  const rs = R.createReportService(store, ts, { now: c.now });
  const cs = C.createCustomerService(store, ts, { now: c.now, reports: rs });
  return { c, store, rows, objects, ts, es, rs, cs };
}
const ASK = { store_id: CUST, phone: '9999900000', issue_category: 'Low or no water flow', description: 'No water' };

async function finishedJob(w) {
  const eng = await w.es.register({ name: 'Ravi', phone: '9876543210', pincode: '122001', id_proof_type: 'pan', id_proof_ref: 'ABCDE1234F' }, ADMIN);
  await w.store.updateEngineer(eng.id, { designation: 'Senior Service Engineer' });
  const o = await w.cs.request(ASK);
  await w.ts.act(o.ticket.id, { action: 'accept', engineer_id: eng.id }, ADMIN);
  const e = await w.store.getEngineer(eng.id);
  await w.ts.engineerAct(e, o.ticket.id, { action: 'arrive' });
  await w.ts.engineerAct(e, o.ticket.id, { action: 'work_done' });
  await w.ts.act(o.ticket.id, { action: 'approve_on_behalf', note: 'ok' }, ADMIN);
  const p = PHOTO(o.ticket.id, 1); w.store.files.add(p);
  await w.ts.engineerAddPhoto(e, o.ticket.id, { path: p, kind: 'other', mime: 'image/jpeg' });
  w.objects[`job-photos/${p}`] = Buffer.from('photo');
  await w.rs.submit(e, o.ticket.id, FORM);
  return { id: o.ticket.id, e };
}

(async () => {
  await test('nothing is removed before 12 months', async () => {
    const w = world(); const { id } = await finishedJob(w);
    w.c.add(364 * 86400);
    const out = await runRetention(w.store, { now: w.c.now });
    assert.strictEqual(out.purged, 0);
    assert.ok(w.rows[0].pdf_path);
    assert.strictEqual((await w.store.listPhotos(id)).length, 1);
  });

  await test('after 12 months photos, videos and the PDF file are removed; the report details stay', async () => {
    const w = world(); const { id } = await finishedJob(w);
    assert.ok(Object.keys(w.objects).some(k => k.startsWith('service-reports/')));
    w.c.add(366 * 86400);
    const out = await runRetention(w.store, { now: w.c.now });
    assert.strictEqual(out.purged, 1);
    assert.strictEqual((await w.store.listPhotos(id)).length, 0);
    assert.ok(!Object.keys(w.objects).length, 'no files left in storage');
    const r = w.rows[0];
    assert.strictEqual(r.pdf_path, null);
    assert.ok(r.media_purged_at);
    assert.strictEqual(r.data.remarks, 'Changed filter');                              // details kept
    assert.strictEqual((await w.store.getTicket(id)).status, 'closed');
    assert.ok((await w.store.listEvents(id)).some(e => e.action === 'media_purged'));
    assert.strictEqual((await runRetention(w.store, { now: w.c.now })).purged, 0);     // not repeated
  });

  await test('an old report still opens: the PDF is rebuilt from the saved details, no storage used', async () => {
    const w = world(); const { id } = await finishedJob(w);
    const before = await w.cs.report({ ...ASK, ticket_id: id });
    assert.doesNotMatch(before.pdf_url, /\/files\/report\//);                          // stored file in year one
    w.c.add(400 * 86400);
    await runRetention(w.store, { now: w.c.now });
    const after = await w.cs.report({ ...ASK, ticket_id: id });
    assert.match(after.pdf_url, /\/files\/report\/.+/);
    const pdf = await w.rs.renderStored(id);
    assert.strictEqual(pdf.slice(0, 4).toString(), '%PDF');
    assert.ok(!Object.keys(w.objects).length, 'rebuilding must not store anything');
  });

  await test('signed links: valid, expired and tampered', async () => {
    const t = L.sign({ k: 'report', tid: 'x' }, 600, 1000000);
    assert.strictEqual(L.verify(t, 1000000 + 1000).tid, 'x');
    assert.strictEqual(L.verify(t, 1000000 + 700 * 1000), null);
    assert.strictEqual(L.verify(t.replace(/.$/, c => (c === 'a' ? 'b' : 'a')), 1000000), null);
    assert.strictEqual(L.verify('garbage'), null);
  });

  await test('visit log: one line per AQUIQ service and per logged visit, newest first', async () => {
    const w = world(); await finishedJob(w);
    w.store.manual = [{ visit_date: '2026-09-01', technician_name: 'Local Tech', technician_phone: '9000000001', work_type: 'pump_repair', work_notes: 'new pump' }];
    const v = await w.cs.visits(ASK);
    assert.strictEqual(v.visits.length, 2);
    assert.strictEqual(v.visits[0].kind, 'aquiq');
    assert.strictEqual(v.visits[1].issue, 'Pump repair');
    await ok400(w.cs.visits({ ...ASK, phone: '9000000000' }), 401);
  });

  await test('Excel and PDF exports contain the visits and carry the AQUIQ letterhead', async () => {
    const w = world(); await finishedJob(w);
    const link = await w.cs.exportLink({ ...ASK, format: 'xlsx' });
    const cid = L.verify(link.url.split('/').pop()).cid;
    const x = await w.cs.buildExport(cid, 'xlsx');
    assert.strictEqual(x.buffer.slice(0, 2).toString(), 'PK');
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.buffer);
    const ws = wb.worksheets[0];
    assert.match(String(ws.getCell('C1').value), /PR TECHNO/);
    assert.ok(ws.getImages().length >= 1, 'logo in the sheet');
    assert.match(String(ws.getRow(7).getCell(5).value), /^PMR/);
    const p = await w.cs.buildExport(cid, 'pdf');
    assert.strictEqual(p.buffer.slice(0, 4).toString(), '%PDF');
    assert.ok(p.buffer.length > 3000);
    await w.c.add(0);
  });

  await test('the service report PDF carries the AQUIQ logo, letterhead and designation', async () => {
    const w = world(); const { id } = await finishedJob(w);
    assert.strictEqual(w.rows[0].data.engineer_designation, 'Senior Service Engineer');
    const pdf = Object.entries(w.objects).find(([k]) => k.startsWith('service-reports/'))[1];
    assert.ok(pdf.length > 8000, 'logo image embedded');
  });

  for (const [s, n] of results) console.log(`${s}  ${n}`);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})();
