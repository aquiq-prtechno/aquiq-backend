'use strict';
// Emails to the customer at each step of a service, sent to the email their AQUIQ account was
// registered with. (The finished service report is emailed by reports.js.) Every send is
// best-effort: a mail problem never blocks a ticket.

const HELP = 'careprtech@hotmail.com · info@prtechno.in (Mon–Sat, 10 AM–6 PM IST)';
const NOTICE = 'This is a system-generated notification from AQUIQ.';
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// One look for every AQUIQ service email: plain text and a styled HTML twin with the same words.
// details = [['Problem', 'Low water flow'], ...]
function buildNotice({ ticket, paragraphs, details = [] }) {
  const name = ticket.contact_person || 'Customer';
  const text = [
    'AQUIQ', '', `Ticket ID: ${ticket.ticket_no}`, ...details.map(([k, v]) => `${k}: ${v}`), '',
    `Hey ${name},`, '', ...paragraphs.flatMap(p => [p, '']),
    'Team: AQUIQ-SERVICE DESK', '', 'Regards,', 'AQUIQ SERVICE-DESK', '',
    '--------------------------------------------------', `${NOTICE} For help, contact ${HELP}.`,
  ].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;max-width:640px">
<p style="margin:0 0 18px;font-size:18px;font-weight:bold;letter-spacing:.5px">AQUIQ</p>
<p style="margin:0 0 4px"><b>Ticket ID:</b> ${esc(ticket.ticket_no)}</p>
${details.map(([k, v]) => `<p style="margin:0 0 4px"><b>${esc(k)}:</b> ${esc(v)}</p>`).join('\n')}
<p style="margin:18px 0 14px">Hey ${esc(name)},</p>
${paragraphs.map(p => `<p style="margin:0 0 14px">${esc(p)}</p>`).join('\n')}
<p style="margin:18px 0"><b>Team:</b> AQUIQ-SERVICE DESK</p>
<p style="margin:0 0 4px">Regards,</p>
<p style="margin:0 0 18px"><b>AQUIQ SERVICE-DESK</b></p>
<div style="border-top:2px solid #2a6fb0;padding-top:10px;font-size:12px;line-height:1.5;color:#8a8f98">${NOTICE} For help, contact ${esc(HELP)}.</div>
</div>`;
  return { text, html };
}

const timeOf = (iso) => new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
}).format(new Date(iso));

function createCustomerMailer(store, mailer, { log = console } = {}) {
  // Goes to the customer's account email with the care team (REPORT_COPY_TO) in CC.
  // If the account has no email, the care team still gets it, marked [AQUIQ team].
  async function send(ticket, subject, paragraphs, details) {
    if (!mailer || !mailer.enabled || !ticket) return { sent: false };
    try {
      const raw = await store.getCustomerEmail(ticket.customer_id);
      const to = raw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw.toLowerCase() : null;
      const copy = mailer.copyTo || null;
      if (!to && !copy) return { sent: false };
      const { text, html } = buildNotice({ ticket, paragraphs: [].concat(paragraphs), details: details || [] });
      if (to) await mailer.send({ to, cc: copy && copy.toLowerCase() !== to ? copy : undefined, subject, text, html });
      else await mailer.send({ to: copy, subject: `[AQUIQ team – customer has no email] ${subject}`, text, html });
      return { sent: !!to };
    } catch (e) { log.error('[MAIL]', ticket.ticket_no, e.message); return { sent: false }; }
  }
  const no = (t) => t.ticket_no;
  const none = async () => ({ sent: false });
  return {
    send,
    created: (t) => send(t, `Service request ${no(t)} received – AQUIQ`,
      ['We have received your service request and are finding an engineer near you.', 'You can follow the progress live in the AQUIQ app under Service History.'],
      [['Problem', `${t.issue_category}${t.urgency === 'urgent' ? ' (urgent)' : ''}`], ['Raised', timeOf(t.created_at)]]),
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

module.exports = { createCustomerMailer, buildNotice };
