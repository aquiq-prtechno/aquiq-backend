'use strict';
// Emails to the customer at each step of a service, sent to the email their AQUIQ account was
// registered with. (The finished service report is emailed by reports.js.) Every send is
// best-effort: a mail problem never blocks a ticket.

const SIGN = '\n\nThank you,\nAQUIQ Service Desk\ncareprtech@hotmail.com · info@prtechno.in (Mon–Sat, 10 AM–6 PM IST)';

const timeOf = (iso) => new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
}).format(new Date(iso));

function createCustomerMailer(store, mailer, { log = console } = {}) {
  // Goes to the customer's account email with the care team (REPORT_COPY_TO) in CC.
  // If the account has no email, the care team still gets it, marked [AQUIQ team].
  async function send(ticket, subject, body) {
    if (!mailer || !mailer.enabled || !ticket) return { sent: false };
    try {
      const raw = await store.getCustomerEmail(ticket.customer_id);
      const to = raw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw.toLowerCase() : null;
      const copy = mailer.copyTo || null;
      if (!to && !copy) return { sent: false };
      const text = `Dear ${ticket.contact_person || 'Customer'},\n\n${body}${SIGN}`;
      if (to) await mailer.send({ to, cc: copy && copy.toLowerCase() !== to ? copy : undefined, subject, text });
      else await mailer.send({ to: copy, subject: `[AQUIQ team – customer has no email] ${subject}`, text });
      return { sent: !!to };
    } catch (e) { log.error('[MAIL]', ticket.ticket_no, e.message); return { sent: false }; }
  }
  const no = (t) => t.ticket_no;
  const none = async () => ({ sent: false });
  return {
    send,
    created: (t) => send(t, `Service request ${no(t)} received – AQUIQ`,
      `We have received your service request.\n\nTicket number: ${no(t)}\nProblem: ${t.issue_category}${t.urgency === 'urgent' ? ' (urgent)' : ''}\nRaised: ${timeOf(t.created_at)}\n\nWe are finding an engineer near you. You can follow the progress in the AQUIQ app under Service History.`),
    assigned: none, // no email when an engineer is assigned (the app and push tell the customer)
    delayed: (t) => send(t, `Update on your service request ${no(t)}`,
      `Your engineer${t.engineer_name ? ` ${t.engineer_name}` : ''} is running late for request ${no(t)}${t.eta_at ? ` (promised by ${timeOf(t.eta_at)})` : ''}. We are sorry for the delay and are following it up. Please check the AQUIQ app for the latest arrival time.`),
    workDone: none, // no email when work is finished; the report email follows after approval
    reopened: (t) => send(t, `We are sorry – your service ${no(t)} is reopened`,
      `Thank you for telling us the work was not satisfactory. Your request ${no(t)} has been reopened and an engineer will come back to fix it. We will keep you updated.`),
  };
}

module.exports = { createCustomerMailer };
