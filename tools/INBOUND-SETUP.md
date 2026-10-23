# Email-to-ticket setup (one time, about 10 minutes)

Do these in your **Work** Chrome profile, signed in as `service.bharat@aquiq-prsons.com`.

1. **Run the SQL.** Supabase → SQL Editor → paste `migrations/2026-10-23_email_tickets.sql` → Run.
2. **Make a secret.** In Terminal: `openssl rand -hex 32` and copy it. Never paste it in chat.
3. **Railway** → service web → Variables → New Variable: `INBOUND_SECRET` = that secret → Deploy.
4. **Gmail filter.** Gmail → Settings (gear) → See all settings → *Filters and Blocked Addresses* → *Create a new filter*.
   - **To:** `r-tickets@aquiq-prsons.com` → *Create filter* → tick **Apply the label** → *New label…* → name it `r-tickets` → *Create filter*.
5. **The script.** Go to script.google.com → *New project* → delete the sample code → paste the whole of `tools/inbound-gmail.gs` → Save (name it "AQUIQ inbound").
6. **Script secret.** In the script: ⚙ *Project Settings* → *Script Properties* → *Add script property*: name `INBOUND_SECRET`, value = the same secret → Save.
7. **Allow it.** Select the function `processRTickets` at the top → *Run*. Google asks for permission (Gmail + "connect to an external service") → Review permissions → choose the account → *Advanced* → *Go to AQUIQ inbound (unsafe)* → Allow. (It says "unsafe" only because you wrote it yourself.)
8. **Every minute.** Left menu ⏰ *Triggers* → *Add Trigger* → function `processRTickets` → event source *Time-driven* → *Minutes timer* → *Every minute* → Save.
9. **Test.** From your Hotmail send a mail to `r-tickets@aquiq-prsons.com` with the subject `Pump noisy test`. Within about 2 minutes you should get the "RECD - PMR… - Pump noisy test - AQUIQ" mail, and the ticket appears in the admin.
