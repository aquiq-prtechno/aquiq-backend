'use strict';
// Emails to the customer at each step of a service, sent to the email their AQUIQ account was
// registered with. (The finished service report is emailed by reports.js.) Every send is
// best-effort: a mail problem never blocks a ticket.

const SIGN = '\n\nThank you,\nAQUIQ Service Desk\ncareprtech@hotmail.com · info@prtechno.in (Mon–Sat, 10 AM–6 PM IST)';

const timeOf = (iso) => new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
}).format(new Date(iso));

function createCustomerMailer(store, mailer, { log = console } = {}) {
  async function send(ticket, subject, body) {
    if (!mailer || !mailer.enabled || !ticket) return { sent: false };
    try {
      const to = await store.getCustomerEmail(ticket.customer_id);
      if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { sent: false };
      await mailer.send({ to: to.toLowerCase(), subject, text: `Dear ${ticket.contact_person || 'Customer'},\n\n${body}${SIGN}` });
      return { sent: true };
    } catch (e) { log.error('[MAIL]', ticket.ticket_no, e.message); return { sent: false }; }
  }
  // Internal copy for the AQUIQ team (REPORT_COPY_TO). Works even if the customer has no email.
  async function staff(ticket, subject, body) {
    const to = mailer && mailer.enabled && mailer.copyTo;
    if (!to || !ticket) return { sent: false };
    try {
      await mailer.send({ to, subject: `[AQUIQ team] ${subject}`, text: `${body}\n\nCustomer: ${ticket.contact_person || '—'}${ticket.contact_phone ? ` · ${ticket.contact_phone}` : ''}\nOpen the admin: https://aquiq-admin.vercel.app` });
      return { sent: true };
    } catch (e) { log.error('[MAIL-STAFF]', ticket.ticket_no, e.message); return { sent: false }; }
  }
  const no = (t) => t.ticket_no;
  const both = (t, subject, body, staffBody) => Promise.all([send(t, subject, body), staff(t, subject, staffBody)]).then(([c]) => c);
  return {
    send,
    staff,
    created: (t) => both(t, `Service request ${no(t)} received – AQUIQ`,
      `We have received your service request.\n\nTicket number: ${no(t)}\nProblem: ${t.issue_category}${t.urgency === 'urgent' ? ' (urgent)' : ''}\nRaised: ${timeOf(t.created_at)}\n\nWe are finding an engineer near you. You can follow the progress in the AQUIQ app under Service History.`,
      `New service request ${no(t)}${t.urgency === 'urgent' ? ' (URGENT)' : ''}.\nProblem: ${t.issue_category}\nRaised: ${timeOf(t.created_at)}. Please assign an engineer.`),
    assigned: (t) => send(t, `Engineer assigned – ${no(t)}`,
      `An AQUIQ engineer has been assigned to your request ${no(t)}.\n\nEngineer: ${t.engineer_name || '—'}${t.eta_at ? `\nExpected by: ${timeOf(t.eta_at)}` : ''}\n\nYou can see the engineer's arrival time in the AQUIQ app.`),
    delayed: (t) => both(t, `Update on your service request ${no(t)}`,
      `Your engineer${t.engineer_name ? ` ${t.engineer_name}` : ''} is running late for request ${no(t)}${t.eta_at ? ` (promised by ${timeOf(t.eta_at)})` : ''}. We are sorry for the delay and are following it up. Please check the AQUIQ app for the latest arrival time.`,
      `Engineer${t.engineer_name ? ` ${t.engineer_name}` : ''} is late for ${no(t)}${t.eta_at ? ` (promised by ${timeOf(t.eta_at)})` : ''}. Please follow up.`),
    workDone: (t) => send(t, `Work completed – please approve – ${no(t)}`,
      `The engineer has finished the work for request ${no(t)}.\n\nPlease open the AQUIQ app (Service History) and tap "Yes, approve the work", or tell us if anything is still wrong. Once approved, you will receive the service report by email.`),
    reopened: (t) => both(t, `We are sorry – your service ${no(t)} is reopened`,
      `Thank you for telling us the work was not satisfactory. Your request ${no(t)} has been reopened and an engineer will come back to fix it. We will keep you updated.`,
      `Customer is NOT satisfied with ${no(t)}. The ticket was reopened. Please follow up.`),
  };
}

module.exports = { createCustomerMailer };
