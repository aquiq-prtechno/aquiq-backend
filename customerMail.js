'use strict';
// Emails to the customer at each step of a service, sent to the email their AQUIQ account was
// registered with. (The finished service report is emailed by reports.js.) Every send is
// best-effort: a mail problem never blocks a ticket.

// The footer under EVERY r-tickets email, in code (monospace) font. Edit the addresses here only.
const SUPPORT = { main: 'service.bharat@aquiq-prsons.com', cc1: 'careaquiq-prsons@aquiq-prsons.com', cc2: 'careprtech@hotmail.com' };
const FOOTER_TEXT = `This is a system-generated e-mail by AQUIQ. If you did not request this action or need assistance, please contact our support team at mailto: ${SUPPORT.main} mailcc: ${SUPPORT.cc1} mailcc: ${SUPPORT.cc2}. Please follow the mailto/cc so our team will reach you soon.`;
const MONO = "Consolas,Menlo,Monaco,'Courier New',monospace";
const footerHtml = () => `<div style="border-top:2px solid #000;margin-top:22px;padding-top:10px;font-family:${MONO};font-size:12px;line-height:1.6;font-style:italic">This is a system-generated e-mail by <b>AQUIQ</b>. If you did not request this action or need assistance, please contact our support team at mailto: <a href="mailto:${SUPPORT.main}?cc=${SUPPORT.cc1},${SUPPORT.cc2}">${SUPPORT.main}</a> mailcc: <a href="mailto:${SUPPORT.cc1}">${SUPPORT.cc1}</a> mailcc: <a href="mailto:${SUPPORT.cc2}">${SUPPORT.cc2}</a>. Please follow the mailto/cc so our team will reach you soon.</div>`;
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// One look for every AQUIQ service email: plain text and a styled HTML twin with the same words.
// details = [['Problem', 'Low water flow'], ...]
function buildNotice({ ticket, paragraphs, details = [] }) {
  const name = ticket.contact_person || 'Customer';
  const text = [
    'AQUIQ', '', `Ticket ID: ${ticket.ticket_no}`, ...details.map(([k, v]) => `${k}: ${v}`), '',
    `Hey ${name},`, '', ...paragraphs.flatMap(p => [p, '']),
    'Team: AQUIQ-SERVICE DESK', '', 'Regards,', 'AQUIQ SERVICE-DESK', '',
    '--------------------------------------------------', FOOTER_TEXT,
  ].join('\n');
  const html = `<div style="font-family:Calibri,Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.5;max-width:640px">
<p style="margin:0 0 18px;font-weight:bold">AQUIQ</p>
<p style="margin:0 0 4px"><b>Ticket ID:</b> ${esc(ticket.ticket_no)}</p>
${details.map(([k, v]) => `<p style="margin:0 0 4px"><b>${esc(k)}:</b> ${esc(v)}</p>`).join('\n')}
<p style="margin:18px 0 14px">Hey ${esc(name)},</p>
${paragraphs.map(p => `<p style="margin:0 0 14px">${esc(p)}</p>`).join('\n')}
<p style="margin:18px 0"><b>Team:</b> AQUIQ-SERVICE DESK</p>
<p style="margin:0 0 4px">Regards,</p>
<p style="margin:0 0 18px"><b>AQUIQ SERVICE-DESK</b></p>
${footerHtml()}
</div>`;
  return { text, html };
}

const WARRANTY_P = 'Our service engineer will visit your premises within stipulated timelines working 8-12 hrs of the complaint being logged (for warranty calls) or from the payment being done (out of warranty/chargeable calls).';
const APPROVE_P = 'Please approve and sign off the complaint from customer app after completion of work sent via our registered visiting service engineers after the job is completed satisfactorily.';
const UNVERIFIED = 'EXTERNAL-UNVERIFIED IN AQUIQ SYSTEM';

// The problem name: for email tickets it is the subject (first line of the description), otherwise the chosen category.
const problemOf = (t) => (t.source === 'email' ? String(t.description || '').split('\n')[0].slice(0, 120) : t.issue_category) || 'Service request';

// "Request received" — the format given by the AQUIQ team.
function buildReceived(t) {
  const problem = problemOf(t);
  const shown = `${problem}${t.urgency === 'urgent' ? ' (URGENT)' : ''}`;
  const name = t.contact_person || 'Customer';
  const raised = timeOfSec(t.created_at);
  const subject = `RECD - ${t.ticket_no} - ${problem} - AQUIQ${t.unverified ? ` - ${UNVERIFIED}` : ''}`;
  const text = [
    ...(t.unverified ? [UNVERIFIED, ''] : []),
    'Greetings of the day!', 'AQUIQ by PR', '',
    `Raised ${raised}`, '',
    `Your service/complaint "${shown}" has been logged with us via reference/ticket Id # ${t.ticket_no}`, '',
    `Respected Sir/Ma'am ${name},`, '',
    'We have received your service request. You can follow the progress live in the AQUIQ app under service history.', '',
    WARRANTY_P, '', APPROVE_P, '',
    'Regards,', '', 'AQUIQ SERVICE DESK', '',
    '--------------------------------------------------', FOOTER_TEXT,
  ].join('\n');
  const html = `<div style="font-family:Calibri,Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.5;max-width:680px">
${t.unverified ? `<p style="margin:0 0 14px;font-weight:bold;color:#b00020">${UNVERIFIED}</p>` : ''}
<p style="margin:0">Greetings of the day!</p>
<p style="margin:0 0 18px"><b>AQUIQ by PR</b></p>
<p style="margin:0 0 18px"><u>Raised ${esc(raised)}</u></p>
<p style="margin:0 0 18px">Your service/complaint &ldquo;${esc(shown)}&rdquo; has been logged with us via reference/ticket Id # <b><i><u>${esc(t.ticket_no)}</u></i></b></p>
<p style="margin:0 0 14px">Respected Sir/Ma&#39;am ${esc(name)},</p>
<p style="margin:0 0 14px">We have received your service request. You can follow the progress live in the AQUIQ app under service history.</p>
<p style="margin:0 0 14px">${WARRANTY_P}</p>
<p style="margin:0 0 18px">${APPROVE_P}</p>
<p style="margin:0 0 4px"><b>Regards,</b></p>
<p style="margin:0"><b>AQUIQ SERVICE DESK</b></p>
${footerHtml()}
</div>`;
  return { subject, text, html };
}

// 23 Oct, 11:12:34 am  (Indian time, with seconds)
const timeOfSec = (iso) => new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
}).format(new Date(iso)).replace(/\bAM\b/, 'am').replace(/\bPM\b/, 'pm');

const timeOf = (iso) => new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
}).format(new Date(iso));

function createCustomerMailer(store, mailer, { log = console } = {}) {
  // Goes to the customer's account email with the care team (REPORT_COPY_TO) in CC.
  // If the account has no email, the care team still gets it, marked [AQUIQ team].
  async function send(ticket, subject, paragraphs, details, built) {
    if (!mailer || !mailer.enabled || !ticket) return { sent: false };
    try {
      // the registered account email first; an unverified email ticket goes back to whoever wrote in
      const registered = ticket.unverified || !ticket.customer_id ? null : await store.getCustomerEmail(ticket.customer_id);
      const raw = registered || ticket.contact_email || null;
      const to = raw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw.toLowerCase() : null;
      const copy = mailer.copyTo || null;
      if (!to && !copy) return { sent: false };
      const { text, html } = built || buildNotice({ ticket, paragraphs: [].concat(paragraphs), details: details || [] });
      const from = mailer.senderFor ? mailer.senderFor('tickets') : undefined;
      if (to) await mailer.send({ to, cc: copy && copy.toLowerCase() !== to ? copy : undefined, subject, text, html, from });
      else await mailer.send({ to: copy, subject: `[AQUIQ team – customer has no email] ${subject}`, text, html, from });
      return { sent: !!to };
    } catch (e) { log.error('[MAIL]', ticket.ticket_no, e.message); return { sent: false }; }
  }
  const no = (t) => t.ticket_no;
  const none = async () => ({ sent: false });
  return {
    send,
    created: (t) => { const m = buildReceived(t); return send(t, m.subject, null, null, m); },
    assigned: none, // no email when an engineer is assigned (the app and push tell the customer)
    delayed: (t) => send(t, `Update on your service request ${no(t)}`,
      [`Your engineer${t.engineer_name ? ` ${t.engineer_name}` : ''} is running late for this request.`, 'We are sorry for the delay and are following it up. Please check the AQUIQ app for the latest arrival time.'],
      [['Problem', t.issue_category], ...(t.eta_at ? [['Promised by', timeOf(t.eta_at)]] : [])]),
    workDone: none, // no email when work is finished; the report email follows after approval
    cancelled: (t) => send(t, `Service request ${no(t)} cancelled`,
      ['As you asked, this service request has been cancelled and no engineer will visit for it.', 'If you still need help, you can raise a new request in the AQUIQ app at any time.'],
      [['Problem', t.issue_category]]),
    reopened: (t) => send(t, `We are sorry – your service ${no(t)} is reopened`,
      ['Thank you for telling us the work was not satisfactory. We are sorry about that.', 'Your request has been reopened and an engineer will come back to fix it. We will keep you updated.'],
      [['Problem', t.issue_category]]),
  };
}

module.exports = { createCustomerMailer, buildNotice, buildReceived, timeOfSec, FOOTER_TEXT, footerHtml, problemOf, esc };
