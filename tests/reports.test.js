'use strict';
// Run:  node tests/reports.test.js
// Covers the service report: unlocking, the engineer-override reasons, auto-filled unit readings,
// closing the ticket, the PDF, email, and photos/videos on a job.
const assert = require('assert');
const T = require('../tickets');
const E = require('../engineers');
const R = require('../reports');
const { memStore, clock, ok400, CUST, customers, ADMIN, fakeAccounts } = require('./helpers');

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed += 1; results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name + '  ->  ' + e.message]); }
}

const PHOTO = (ticketId, n, ext = 'jpg') => `jobs/${ticketId}/0000000${n}-0000-4000-8000-000000000000.${ext}`;
const FORM = {
  overall_status: 'Completed', capacity: '100/150 LPH', tds_status: 'NO ISSUE (USER)', load: 'No Fluctuation',
  remarks: 'Changed sediment filter',
};

function world({ mailer, customer } = {}) {
  const c = clock('2026-10-13T06:00:00Z');
  const store = memStore(customer ? { [CUST]: customer } : customers);
  // report-side fakes
  const reportsRows = [];
  const objects = {};
  store.getReportByTicket = async (id) => JSON.parse(JSON.stringify(reportsRows.find(r => r.ticket_id === id) || null));
  store.insertReport = async (row) => {
    if (reportsRows.some(r => r.ticket_id === row.ticket_id)) { const e = new Error('dup'); e.status = 409; throw e; }
    const r = { id: `00000000-0000-4000-b000-${String(reportsRows.length + 1).padStart(12, '0')}`, ...JSON.parse(JSON.stringify(row)) };
    reportsRows.push(r); return JSON.parse(JSON.stringify(r));
  };
  store.updateReport = async (id, patch) => { Object.assign(reportsRows.find(r => r.id === id), patch); };
  store.deleteReport = async (id) => { const i = reportsRows.findIndex(r => r.id === id); if (i >= 0) reportsRows.splice(i, 1); };
  store.uploadObject = async (bucket, path, buf) => { objects[`${bucket}/${path}`] = buf; };
  store.getCustomerEmail = async () => 'owner@saffron.test';
  const es = E.createEngineerService(store, { now: c.now, auth: fakeAccounts() });
  const ts = T.createTicketService(store, { now: c.now });
  const sent = [];
  const mail = mailer === 'off' || !mailer
    ? undefined
    : { enabled: true, copyTo: 'careprtech@hotmail.com', send: mailer === 'fail' ? async () => { throw new Error('smtp down'); } : async (m) => { sent.push(m); } };
  const rs = R.createReportService(store, ts, { now: c.now, mailer: mail, fetchBytes: async () => Buffer.from('not-an-image') });
  return { c, store, es, ts, rs, reportsRows, objects, sent };
}

async function engineerOnJob(w, name = 'Ravi', phone = '9876543210') {
  const eng = await w.es.register({ name, phone, pincode: '122001', id_proof_type: 'driving_licence', id_proof_ref: `DL-${name}` }, ADMIN);
  const t = await w.ts.create({ customer_id: CUST, description: 'No water since morning', issue_category: 'Low or no water flow' }, ADMIN);
  await w.ts.act(t.id, { action: 'accept', engineer_id: eng.id, eta_minutes: 30 }, ADMIN);
  const e = await w.store.getEngineer(eng.id);
  return { e, t };
}
async function toWorkDone(w, e, t) {
  await w.ts.engineerAct(e, t.id, { action: 'arrive', lat: 28.45, lng: 77.02 });
  for (const [n, kind] of [[1, 'before'], [2, 'after']]) {
    const path = PHOTO(t.id, n); w.store.files.add(path);
    await w.ts.engineerAddPhoto(e, t.id, { path, kind, mime: 'image/jpeg' });
  }
  await w.ts.engineerAct(e, t.id, { action: 'work_done', checklist: { flushed: true, leaks: true, tds: true, pump: true, clean: true } });
}

(async () => {
  await test('the report is locked until the work is marked done; then needs a reason; after approval it is ready', async () => {
    const w = world(); const { e, t } = await engineerOnJob(w);
    assert.strictEqual((await w.rs.form(e, t.id)).state, 'locked');
    await toWorkDone(w, e, t);
    assert.strictEqual((await w.rs.form(e, t.id)).state, 'needs_reason');
    await w.ts.act(t.id, { action: 'approve_on_behalf', note: 'customer confirmed by phone' }, ADMIN);
    const f = await w.rs.form(e, t.id);
    assert.strictEqual(f.state, 'ready');
    assert.strictEqual(f.report_no, `FSR-${t.ticket_no}`);
    assert.strictEqual(f.admin_name, undefined);               // contact person is not shown to the engineer any more
    assert.match(f.location, /Sector 14/);
  });

  await test('privacy: contact person and number are visible only while doing the job', async () => {
    const w = world(); const { e, t } = await engineerOnJob(w);
    let job = await w.ts.engineerJob(e, t.id);
    assert.strictEqual(job.contact_phone, '9999900000');
    assert.strictEqual(job.contact_person, 'Hotel Saffron');
    await toWorkDone(w, e, t);
    job = await w.ts.engineerJob(e, t.id);
    assert.strictEqual(job.contact_phone, null);
    assert.strictEqual(job.contact_person, null);
    const listed = (await w.ts.engineerJobs(e)).mine[0];
    assert.strictEqual(listed.contact_phone, null);
    await w.ts.act(t.id, { action: 'approve_on_behalf', note: 'ok' }, ADMIN);
    await w.rs.submit(e, t.id, FORM);
    assert.ok(!JSON.stringify(await w.rs.form(e, t.id)).includes('9999900000'));
    assert.strictEqual(w.reportsRows[0].data.admin_name, undefined);
  });

  await test('the six unit readings come from the device, never from what the engineer sends', async () => {
    const w = world(); const { e, t } = await engineerOnJob(w);
    await toWorkDone(w, e, t);
    await w.ts.act(t.id, { action: 'approve_on_behalf', note: 'ok' }, ADMIN);
    await w.rs.submit(e, t.id, { ...FORM, tds_input: '999', output_tds: '1', pump_condition: 'Faulty', feed_tds: '5', membrane: '1%' });
    const r = w.reportsRows[0];
    assert.strictEqual(r.device_readings.output_tds, '212 ppm');
    assert.strictEqual(r.device_readings.feed_tds, '480 ppm');
    assert.strictEqual(r.device_readings.output_flow, '1.1 L/min');
    assert.strictEqual(r.device_readings.reject_flow, '2.9 L/min');
    assert.strictEqual(r.device_readings.pump_condition, 'Running weak – needs attention');
    assert.strictEqual(r.device_readings.membrane, 'Not available');       // unit sent none: shown, not guessed
    assert.ok(!JSON.stringify(r.data).includes('999'));
  });

  await test('filing the report closes the ticket, stores the PDF and logs it', async () => {
    const w = world(); const { e, t } = await engineerOnJob(w);
    await toWorkDone(w, e, t);
    await w.ts.act(t.id, { action: 'approve_on_behalf', note: 'ok' }, ADMIN);
    const out = await w.rs.submit(e, t.id, FORM);
    assert.strictEqual(out.report_no, `FSR-${t.ticket_no}`);
    assert.strictEqual(out.approval_mode, 'admin');
    assert.match(out.pdf_url, /service-reports\/.+\.pdf/);
    assert.strictEqual((await w.store.getTicket(t.id)).status, 'closed');
    const pdf = Object.values(w.objects)[0];
    assert.strictEqual(pdf.slice(0, 4).toString(), '%PDF');
    assert.ok((await w.store.listEvents(t.id)).some(ev => ev.action === 'report_filed'));
    assert.strictEqual(out.email_status, 'disabled');                       // mail not set up: nothing breaks
  });

  await test('without approval the engineer must give a reason; it is recorded on the report and the ticket', async () => {
    const w = world(); const { e, t } = await engineerOnJob(w);
    await toWorkDone(w, e, t);
    await ok400(w.rs.submit(e, t.id, FORM), 400, /why/i);
    await ok400(w.rs.submit(e, t.id, { ...FORM, override_reason: 'because' }), 400);
    await ok400(w.rs.submit(e, t.id, { ...FORM, override_reason: 'other', override_note: 'x' }), 400, /reason/i);
    const out = await w.rs.submit(e, t.id, { ...FORM, override_reason: 'next_complaint' });
    assert.strictEqual(out.approval_mode, 'engineer_override');
    const tk = await w.store.getTicket(t.id);
    assert.strictEqual(tk.status, 'closed');
    assert.strictEqual(tk.customer_response, 'bypassed_by_engineer');
    assert.match(w.reportsRows[0].override_reason, /next complaint/);
    assert.ok((await w.store.listEvents(t.id)).some(ev => ev.action === 'engineer_override'));
  });

  await test('"Other" reason uses the engineer’s own words', async () => {
    const w = world(); const { e, t } = await engineerOnJob(w);
    await toWorkDone(w, e, t);
    await w.rs.submit(e, t.id, { ...FORM, override_reason: 'other', override_note: 'Customer was abroad' });
    assert.strictEqual(w.reportsRows[0].override_reason, 'Customer was abroad');
  });

  await test('the report cannot be saved without at least one site photo', async () => {
    const w = world(); const { e, t } = await engineerOnJob(w);
    await w.ts.engineerAct(e, t.id, { action: 'arrive', lat: 28.45, lng: 77.02 });
    await w.ts.engineerAct(e, t.id, { action: 'work_done', checklist: { flushed: true, leaks: true, tds: true, pump: true, clean: true } });      // no photos needed to finish the work
    await w.ts.act(t.id, { action: 'approve_on_behalf', note: 'ok' }, ADMIN);
    await ok400(w.rs.submit(e, t.id, FORM), 400, /site photo/);
    const path = PHOTO(t.id, 1); w.store.files.add(path);
    await w.ts.engineerAddPhoto(e, t.id, { path, kind: 'other', mime: 'image/jpeg' });   // allowed after approval too
    await w.rs.submit(e, t.id, FORM);
    assert.strictEqual((await w.store.getTicket(t.id)).status, 'closed');
  });

  await test('missing or invalid choices are refused with a clear message', async () => {
    const w = world(); const { e, t } = await engineerOnJob(w);
    await toWorkDone(w, e, t);
    await w.ts.act(t.id, { action: 'approve_on_behalf', note: 'ok' }, ADMIN);
    await ok400(w.rs.submit(e, t.id, { ...FORM, load: '' }), 400, /load/i);
    await ok400(w.rs.submit(e, t.id, { ...FORM, overall_status: 'BROKEN' }), 400, /not a valid choice/);
    assert.strictEqual(w.reportsRows.length, 0);
    assert.strictEqual((await w.store.getTicket(t.id)).status, 'approved');   // nothing half-done
  });

  await test('only once, only the assigned engineer, and only after work is done', async () => {
    const w = world(); const { e, t } = await engineerOnJob(w);
    await ok400(w.rs.submit(e, t.id, FORM), 409, /after you mark/);
    await toWorkDone(w, e, t);
    const other = await w.es.register({ name: 'Amit', phone: '9811100000', pincode: '122001', id_proof_type: 'pan', id_proof_ref: 'ABCDE1234F' }, ADMIN);
    await ok400(w.rs.submit(await w.store.getEngineer(other.id), t.id, FORM), 404);
    await w.ts.act(t.id, { action: 'approve_on_behalf', note: 'ok' }, ADMIN);
    await w.rs.submit(e, t.id, FORM);
    await ok400(w.rs.submit(e, t.id, FORM), 409, /already/);
  });

  await test('admin cannot use the engineer-only action', async () => {
    const w = world(); const { e, t } = await engineerOnJob(w);
    await toWorkDone(w, e, t);
    await ok400(w.ts.act(t.id, { action: 'engineer_override', note: 'x' }, ADMIN), 400);
    const d = await w.ts.detail(t.id);
    assert.ok(!d.actions.some(a => a.action === 'engineer_override'));
  });

  await test('email goes to the customer with a copy to AQUIQ; a mail failure never undoes the report', async () => {
    const w = world({ mailer: 'ok' }); const { e, t } = await engineerOnJob(w);
    await toWorkDone(w, e, t);
    await w.ts.act(t.id, { action: 'approve_on_behalf', note: 'ok' }, ADMIN);
    const out = await w.rs.submit(e, t.id, FORM);
    assert.strictEqual(out.email_status, 'sent');
    assert.deepStrictEqual(w.sent[0].to, ['owner@saffron.test']);
    assert.strictEqual(w.sent[0].cc, 'careprtech@hotmail.com');
    assert.strictEqual(w.sent[0].attachments[0].filename, `FSR-${t.ticket_no}.pdf`);

    const f = world({ mailer: 'fail' }); const j = await engineerOnJob(f);
    await toWorkDone(f, j.e, j.t);
    await f.ts.act(j.t.id, { action: 'approve_on_behalf', note: 'ok' }, ADMIN);
    const out2 = await f.rs.submit(j.e, j.t.id, FORM);
    assert.strictEqual(out2.email_status, 'failed');
    assert.strictEqual((await f.store.getTicket(j.t.id)).status, 'closed');
    assert.strictEqual(f.reportsRows[0].email_status, 'failed');
  });

  await test('photos and videos: up to 20 photos and 3 videos, counted separately; videos need a video type', async () => {
    const w = world(); const { e, t } = await engineerOnJob(w);
    await w.ts.engineerAct(e, t.id, { action: 'arrive', lat: 28.45, lng: 77.02 });
    const vid = await w.ts.engineerPhotoUpload(e, t.id, { content_type: 'video/mp4', kind: 'other' });
    assert.strictEqual(vid.media_type, 'video');
    assert.strictEqual(vid.max_bytes, 20 * 1024 * 1024);
    for (let n = 1; n <= 3; n++) {
      const p = PHOTO(t.id, n, 'mp4'); w.store.files.add(p);
      await w.ts.engineerAddPhoto(e, t.id, { path: p, kind: 'other', mime: 'video/mp4' });
    }
    await ok400(w.ts.engineerPhotoUpload(e, t.id, { content_type: 'video/mp4', kind: 'other' }), 409, /at most 3 videos/);
    for (let n = 1; n <= 20; n++) {
      const p = `jobs/${t.id}/${String(n).padStart(8, '0')}-0000-4000-8000-000000000001.jpg`; w.store.files.add(p);
      await w.ts.engineerAddPhoto(e, t.id, { path: p, kind: n % 2 ? 'before' : 'after', mime: 'image/jpeg' });
    }
    await ok400(w.ts.engineerPhotoUpload(e, t.id, { content_type: 'image/jpeg', kind: 'other' }), 409, /at most 20 photos/);
    await ok400(w.ts.engineerPhotoUpload(e, t.id, { content_type: 'application/pdf', kind: 'other' }), 400);
    const job = await w.ts.engineerJob(e, t.id);
    assert.strictEqual(job.photos.filter(p => p.media_type === 'video').length, 3);
  });

  await test('designation is printed with the engineer name and kept on the report', async () => {
    const w = world(); const { e, t } = await engineerOnJob(w);
    await w.store.updateEngineer(e.id, { designation: 'Senior Service Engineer' });
    const e2 = await w.store.getEngineer(e.id);
    await toWorkDone(w, e2, t);
    await w.ts.act(t.id, { action: 'approve_on_behalf', note: 'ok' }, ADMIN);
    await w.rs.submit(e2, t.id, FORM);
    assert.strictEqual(w.reportsRows[0].data.engineer_designation, 'Senior Service Engineer');
    assert.ok(!('model' in w.reportsRows[0].data) && !('stand' in w.reportsRows[0].data));
  });

  await test('service name comes from the issue; falls back to the standard sample line', async () => {
    assert.strictEqual(R.serviceName({ ticket_no: 'PMR1', issue_category: 'Low or no water flow' }), 'Low or no water flow – RESOLVED');
    assert.strictEqual(R.serviceName({ ticket_no: 'PMR2611790001013', issue_category: 'Other', description: '' }), 'ISSUE - PMR2611790001013 RESOLVED - AQUIQ');
  });

  await test('PDF mentions "without customer approval" when the engineer overrode', async () => {
    const pdf = await R.renderPdf({
      report_no: 'FSR-X', ticket_no: 'X', service_name: 'S', when_label: 'now', location: 'L', admin_name: 'A', site_place: 'P',
      data: { ...FORM }, device_readings: { output_tds: '1 ppm', stale: true, captured_at: '2026-10-13T06:00:00Z' },
      approval_mode: 'engineer_override', override_reason: 'Customer is taking time', approval_label: 'Filed WITHOUT customer approval.',
      engineer_name: 'Ravi', engineer_code: 'ENG-1001', engineer_designation: 'Senior Service Engineer', videos: [{ kind: 'after', when: 'now' }],
    }, []);
    assert.strictEqual(pdf.slice(0, 4).toString(), '%PDF');
    assert.ok(pdf.length > 1500);
  });

  await test('closing mail: REF/TIC CLOSED subject, SOLVED/CLOSED status, Sir/Ma\'am, code-font footer, no WMS / PR TECHNO', async () => {
    const t = { ticket_no: 'PMR2611790171023', contact_person: 'Anuj Thakur', issue_category: 'Machine not switching on', urgency: 'normal', source: 'customer_app' };
    const m = R.buildReportMail(t, { report_no: 'FSR-PMR2611790171023', service_name: 'x' });
    assert.strictEqual(m.subject, 'REF/TIC CLOSED : FSR-PMR2611790171023 – Machine not switching on');
    assert.match(m.text, /^Greetings of the day!\nAQUIQ by PR\n\nSTATUS : SOLVED\/CLOSED\n\nYour service\/complaint\/installation "Machine not switching on" has been closed with us via reference\/ticket Id # PMR2611790171023/);
    assert.match(m.text, /Respected Sir\/Ma'am Anuj Thakur,/);
    assert.match(m.text, /No pending actions remain from the HELPDESK team\. The ticket is hereby marked as CLOSED\./);
    assert.match(m.text, /All recipients copied \(mailto\/cc\) in this email are considered part of the communication trail and project record\./);
    assert.match(m.text, /Regards,\n\nAQUIQ by PR\n/);
    assert.match(m.text, /mailto: service\.bharat@aquiq-prsons\.com mailcc: careaquiq-prsons@aquiq-prsons\.com mailcc: careprtech@hotmail\.com\. Please follow/); assert.match(m.text, /Powered by PR SONS$/); assert.match(m.html, /Powered by PR SONS<\/div>/);
    assert.match(m.html, /<b>STATUS : SOLVED\/CLOSED<\/b>/); assert.match(m.html, /font-family:Consolas/); assert.match(m.html, /<b><i><u>PMR2611790171023<\/u><\/i><\/b>/);
    assert.ok(!/WMS|PR TECHNO/.test(m.text + m.html));
    assert.match(R.buildReportMail({ ...t, urgency: 'urgent' }, {}).text, /"Machine not switching on \(URGENT\)"/);
    assert.match(R.buildReportMail({ ...t, source: 'email', description: 'Pump noisy\nbody' }, {}).subject, /– Pump noisy$/, 'email tickets use the subject as the problem name');
    assert.match(R.buildReportMail({ ...t, contact_person: '<b>x</b>' }, {}).html, /Ma&#39;am &lt;b&gt;x&lt;\/b&gt;,/, 'html-escaped');
  });

  for (const [s, n] of results) console.log(`${s}  ${n}`);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL ${passed} PASSED`);
  process.exit(failed ? 1 : 0);
})();
