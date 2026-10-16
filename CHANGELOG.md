# AQUIQ backend — release history
Series: MAJOR.MINOR.PATCH. MINOR = new feature, PATCH = fix. Current version is also at `GET /version`.

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
