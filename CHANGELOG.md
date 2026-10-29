# AQUIQ backend — release history
Series: MAJOR.MINOR.PATCH. MINOR = new feature, PATCH = fix. Current version is also at `GET /version`.

## 1.10.4 — 29 Oct 2026
- The admin sign-in mails (invite, forgot password) show the sender name noreply-aquiq (was AQUIQ by PR SONS). MAIL_NAME_NOREPLY can change it. Mail relay's RELAY_ALLOWED_FROM (Vercel, aquiq-admin) now lists no-reply@aquiq-prsons.com.

## 1.10.3 — 28 Oct 2026
- The log line for a refused no-reply sender now includes the mail relay's own answer, so the reason is visible.

## 1.10.2 — 28 Oct 2026
- One look for every AQUIQ email: new mailLayout.js puts the logo, AQUIQ by PR SONS and a teal line on top and centres the body (Calibri 11). Applied to the request-received, delay, cancelled, reopened and ticket-closed mails, the login / confirmation / reset code mails and the test mail. The wording, subjects and the code-font footer are unchanged.
- Admin sign-in mails now come from us, not the Supabase templates: new public POST /auth/forgot-password (same answer for any email, limited per email and per address) and the Team Access invite emails the link itself, both in the AQUIQ layout from no-reply@aquiq-prsons.com (name AQUIQ by PR SONS; MAIL_FROM_NOREPLY / MAIL_NAME_NOREPLY can change it; falls back to the accounts sender if the alias is refused). authMail.js. Latest admin 1.7.3.

## 1.10.1 — 27 Oct 2026
- A frozen account's admin request now answers 403 with code "disabled" so the admin panel can send the person back to sign in with the frozen message. Latest admin 1.7.2.

## 1.10.0 — 27 Oct 2026
- Team (Emp) rights. adminAuth.js: each Team (Emp) person has a state (active / readonly; frozen = switched off) and per-right switches stored in Supabase app_metadata; the server decides every admin request (read-only = no changes; unlisted changes refused; owner-only team routes). New routes: GET /admin/me, POST /admin/team/:id/access (owner), GET /admin/activity (owner); invite rules: a Team (Emp) person may add one Team (Emp) member only, never an owner, and people they added may not add. New people start read-only with every right off. Every change and every refusal is written to admin_activity (SQL: migrations/2026-10-27_admin_activity.sql). Latest admin 1.7.0.

## 1.9.0 — 24 Oct 2026
- Unique ID (WI) (the device's WiFi ID): sent to service engineers as a compact value (51916AQPR783B01) on offers and jobs, only for stores with an AQUIQ device that is powered on (data in the last 5 min); printed in code font under the FSR number on the service report (same rules); never shown in History. Latest engineer 1.5.1, admin 1.6.5.

## 1.8.11 — 24 Oct 2026
- Latest admin 1.6.4.

## 1.8.10 — 24 Oct 2026
- Latest admin 1.6.3.

## 1.8.9 — 24 Oct 2026
- Latest admin 1.6.2.

## 1.8.8 — 24 Oct 2026
- Latest engineer app 1.5.0 (new APK: gradient, wave, site map). Older engineer apps are flagged as outdated.

## 1.8.7 — 24 Oct 2026
- Latest engineer app 1.3.2.

## 1.8.6 — 24 Oct 2026
- Latest engineer app 1.3.1.

## 1.8.5 — 24 Oct 2026
- Latest engineer app 1.3.0 (redesign).

## 1.8.4 — 24 Oct 2026
- Latest customer app 1.10.0 (company dashboard redesign).

## 1.8.3 — 24 Oct 2026
- Support e-mail in Ask AQUIQ answers/knowledge is now careaquiq-prsons@aquiq-prsons.com (was careprtech@hotmail.com / info@prtechno.in). Latest customer 1.9.2.

## 1.8.2 — 24 Oct 2026
- PR SONS logo now in navy, teal and gold, horizontal (mark left, "PR SONS" right). Service report header: logo, then AQUIQ™ in bold navy; FSR no., ticket and date/time in code font. Footer shows r-tickets@ and careaquiq-prsons@ in code font. Fixed "undefined – undefined" in the T.D.S Output row. Latest customer 1.9.1, admin 1.6.1.

## 1.8.1 — 24 Oct 2026
- Latest customer app 1.9.0, admin 1.6.0 (company branding).

## 1.8.0 — 24 Oct 2026
- PR SONS company logo (dark blue, navy) in the header of every service report PDF and on the Visit Log exports; "Powered by PR SONS" in code font at the foot of every PDF page and under every ticket / closing / code email. Company-name mentions (PR TECHNO) changed to AQUIQ in the assistant and messages (addresses and domains unchanged).

## 1.7.1 — 24 Oct 2026
- Latest customer app version is 1.8.1.

## 1.7.0 — 24 Oct 2026
- "Your RO has stopped" notice: when the pump has been OFF for 10 minutes (device online, between 6 am and 10 pm IST, within 90 minutes of the stop) the customer gets ONE push asking them to check if the tank is full, and to raise a request if not. Tracked with customers.pump_off_since / pump_off_notified_at (needs migration 2026-10-24_ro_stopped.sql; until it is run tracking pauses quietly and device data is unaffected). Ask AQUIQ explains why an RO stops and what the card colours mean. Latest customer app 1.8.0.

## 1.6.8 — 24 Oct 2026
- Latest customer app version is 1.7.2.

## 1.6.7 — 24 Oct 2026
- Latest customer app version is 1.7.1.

## 1.6.6 — 24 Oct 2026
- Login, email-confirmation and password-reset code mails are now sent from the reports address (info.fs.reports-no-reply@) instead of the default mailbox. New optional sender kind: MAIL_FROM_ACCOUNTS (defaults to MAIL_FROM_REPORTS).

## 1.6.5 — 23 Oct 2026
- Ask AQUIQ answers describe the new bottom bar (Service button) in the customer app 1.7.0; latest customer app version is 1.7.0.

## 1.6.4 — 23 Oct 2026
- A ticket cancelled by the admin now also emails the customer (from r-tickets@, care team in CC); the internal cancel note is not shown. Not sent for unverified email senders.

## 1.6.3 — 23 Oct 2026
- "Not satisfied": the job is reopened but NOT pushed, offered or takeable by any engineer (the previous engineer no longer sees it either). The AQUIQ admin team talks to the customer first and then assigns an engineer. Reopened mail now says the helpdesk will contact the customer.

## 1.6.2 — 23 Oct 2026
- Mail body font: Calibri 11 pt for all ticket and closing mails (the support footer stays in code font). /admin/mail-status also reports which address sends ticket mails, report mails and where replies go.

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
