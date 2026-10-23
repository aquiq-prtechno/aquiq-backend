/**
 * AQUIQ — email-to-ticket script. Runs INSIDE the Google account service.bharat@aquiq-prsons.com.
 * Every minute it looks at mail carrying the Gmail label set by the filter on r-tickets@ and posts each NEW message
 * to the AQUIQ server. It remembers the time of the last message it handled (LAST_TS), so it does not matter whether
 * someone has opened the mail in Gmail; the server also ignores a message it has already seen.
 * Setup steps are in tools/INBOUND-SETUP.md.
 */
const ENDPOINT = 'https://web-production-85fd6.up.railway.app/inbound/email';   // the AQUIQ backend
const LABEL = 'RT-Aquiq';          // the Gmail label your filter applies (must match exactly)

function parseFrom_(from) {
  const m = String(from).match(/^(.*?)<([^>]+)>\s*$/);
  return m ? { name: m[1].replace(/["']/g, '').trim(), email: m[2].trim() } : { name: '', email: String(from).trim() };
}

function processRTickets() {
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty('INBOUND_SECRET');
  if (!secret) throw new Error('Set the script property INBOUND_SECRET first.');
  let last = Number(props.getProperty('LAST_TS') || 0);

  // every message with the label from the last 2 days, oldest first
  const msgs = [];
  GmailApp.search('label:' + LABEL + ' newer_than:2d', 0, 30).forEach(function (t) {
    t.getMessages().forEach(function (m) { if (m.getDate().getTime() > last) msgs.push(m); });
  });
  msgs.sort(function (a, b) { return a.getDate() - b.getDate(); });

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    const from = parseFrom_(msg.getFrom());
    const payload = {
      message_id: msg.getHeader('Message-ID') || msg.getId(),
      from_name: from.name,
      from_email: from.email,
      subject: msg.getSubject(),
      body: msg.getPlainBody().slice(0, 4000),
      auto_submitted: msg.getHeader('Auto-Submitted'),
      precedence: msg.getHeader('Precedence'),
      received_at: msg.getDate().toISOString(),
    };
    const res = UrlFetchApp.fetch(ENDPOINT, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'X-Inbound-Secret': secret }, payload: JSON.stringify(payload),
    });
    const code = res.getResponseCode();
    if (code !== 200) { console.error('AQUIQ answered ' + code + ': ' + res.getContentText()); break; }   // retried next minute
    last = msg.getDate().getTime();
    props.setProperty('LAST_TS', String(last));
  }
}
