# AQUIQ backend — release history
Series: MAJOR.MINOR.PATCH. MINOR = new feature, PATCH = fix. Current version is also at `GET /version`.

## 1.6.1 — 23 Oct 2026
- Closing mail (with the service report PDF) in the AQUIQ format: subject "REF/TIC CLOSED : FSR-<PMR> – <problem>", STATUS : SOLVED/CLOSED, "Respected Sir/Ma'am", code-font support footer. Sent from info.fs.reports-no-reply@ (needs that address in Gmail "Send mail as").

## 1.6.0 — 23 Oct 2026
- Email-to-ticket: mail to r-tickets@ opens a ticket (a Google Apps Script in the mailbox posts each mail to POST /inbound/email, secret INBOUND_SECRET). Replies that quote a PMR number become notes; unregistered senders get a ticket marked EXTERNAL-UNVERIFIED IN AQUIQ SYSTEM that an admin links to a store; bounces / auto-replies / our own addresses are ignored; 5 tickets per sender per day. Category "ISSUE/PROBLEM", subject = problem name, URGENT in the subject = urgent. Needs migration 2026-10-23_email_tickets.sql.
- New "request received" mail format (RECD - PMR - problem - AQUIQ, Respected Sir/Ma'am, seconds, warranty paragraph) and the code-font support footer under every r-tickets mail.

## 1.5.3 — 22 Oct 2026
- Mail can go out from different addresses: MAIL_FROM_TICKETS (request received / late / reopened / cancelled), MAIL_FROM_REPORTS (closing mail + report PDF), MAIL_REPLY_TO. Nothing changes until these Railway variables are set.

## 1.5.2 — 19 Oct 2026
- Request received, engineer late, reopened and cancelled emails now use the same AQUIQ layout as the service report (own wording for each, HTML + plain text).

## 1.5.1 — 19 Oct 2026
- New service-report email: subject "SERVICE REPORT – FSR-<ticket>", AQUIQ-FSR body (Hey <customer>, Team, Closed By = who approved, Regards AQUIQ FSR-ADMIN, system-generated notice). Styled HTML version plus plain text.

## 1.5.0 — 19 Oct 2026
- Customer can cancel a request until the engineer arrives (POST /customer/service-request/cancel). Ticket closes, engineer gets a push, customer gets an email with the care team in CC.

## 1.4.3 — 16 Oct 2026
- Care team is now in CC on every customer email (replaces the separate team emails). No email when an engineer is assigned or when work is finished. Customers with no email: the care team still gets a flagged copy.

## 1.4.2 — 16 Oct 2026
- The AQUIQ team (REPORT_COPY_TO) now also gets an email when a customer raises a ticket, an engineer is late, or a customer is not satisfied. Mail-test errors are readable.

## 1.4.1 — 18 Oct 2026
- Mail provider `relay` (MAIL_PROVIDER=relay, MAIL_RELAY_URL, MAIL_RELAY_SECRET). App-password spaces ignored.

## 1.4.0 — 18 Oct 2026
- Mail providers (SMTP / Brevo / Resend over HTTPS), admin mail test. Map card rules (accepted → work done). App version reporting + latest-version list (versions.js). Migration section 11.

## 1.3.0 — 17 Oct 2026
- Contact details: stores add an email, company accounts add email / change mobile, all with a 6-digit code.
- Store login with a confirmed email + code. Company (UHAD) login on the server with hashed passwords; forgot-password by emailed code; admin reset stores a hash.
- Admin "All Accounts" API. Ask AQUIQ brain (knowledge base + customer's visit log + optional AI model).
- Customer emails at every service step. Version endpoint.

## 1.2.0 — 16 Oct 2026
- Field rules: arrival geo-check, checklist, spare parts, duty switch, SOP acceptance, repeat flag, rating, engineer scorecard.
- Push notifications, live engineer location + arrival time for the customer.

## 1.1.0 — 15 Oct 2026
- Service report (PDF with AQUIQ letterhead), visit log with Excel / PDF export, 12-month clean-up, customer approval.

## 1.0.0 — 13–14 Oct 2026
- Service tickets (PMR numbers), engineer register, engineer app API, customer "Request Service".
