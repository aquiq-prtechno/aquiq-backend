'use strict';
// 12-month clean-up: photos, videos and the report PDF file of a service are deleted
// 12 months after the engineer saved the report. The visit log and every report detail stay
// for good, and the PDF can still be rebuilt on request (without photos).

const { PHOTO_BUCKET } = require('./tickets');
const { REPORT_BUCKET } = require('./reports');

const RETENTION_MONTHS = 12;

function cutoff(now, months = RETENTION_MONTHS) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

async function runRetention(store, { now = () => new Date(), months = RETENTION_MONTHS, batch = 50, log = console } = {}) {
  const due = await store.listReportsDue(cutoff(now(), months), batch);
  let purged = 0;
  for (const r of due) {
    try {
      const media = await store.listPhotos(r.ticket_id);
      await store.deleteObjects(PHOTO_BUCKET, media.map(m => m.path));
      if (r.pdf_path) await store.deleteObjects(REPORT_BUCKET, [r.pdf_path]);
      await store.deletePhotoRows(r.ticket_id);
      const at = now().toISOString();
      await store.updateReport(r.id, { media_purged_at: at, pdf_purged_at: r.pdf_path ? at : null, pdf_path: null });
      await store.insertEvent({
        ticket_id: r.ticket_id, actor: 'system', actor_role: 'system', action: 'media_purged',
        from_status: 'closed', to_status: 'closed', note: `Photos, videos and PDF removed after ${months} months`,
        meta: { photos: media.length },
      });
      purged += 1;
    } catch (err) {
      log.error('[RETENTION]', r.report_no, err.message);   // try again tomorrow
    }
  }
  return { due: due.length, purged };
}

module.exports = { runRetention, cutoff, RETENTION_MONTHS };
