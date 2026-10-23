/**
 * AQUIQ — email-to-ticket script. Runs INSIDE the Google account service.bharat@aquiq-prsons.com.
 * Every minute it looks at mail to r-tickets@ (label "r-tickets") and posts each unread message to the AQUIQ server.
 * Setup steps are in tools/INBOUND-SETUP.md.
 */
const ENDPOINT = 'https://web-production-85fd6.up.railway.app/inbound/email';   // the AQUIQ backend
const LABEL = 'r-tickets';                                                         // Gmail label set by the filter

function parseFrom_(from) {
  const m = String(from).match(/^(.*?)<([^>]+)>\s*$/);
  return m ? { name: m[1].replace(/["']/g, '').trim(), email: m[2].trim() } : { name: '', email: String(from).trim() };
}

function processRTickets() {
  const secret = PropertiesService.getScriptProperties().getProperty('INBOUND_SECRET');
  if (!secret) throw new Error('Set the script property INBOUND_SECRET first.');
  const threads = GmailApp.search('label:' + LABEL + ' is:unread newer_than:3d', 0, 25);
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      if (!msg.isUnread()) return;
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
      if (code === 200) msg.markRead();                  // done: never sent again
      else console.error('AQUIQ answered ' + code + ': ' + res.getContentText());   // stays unread, retried next minute
    });
  });
}
