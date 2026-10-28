'use strict';
// The outer look of EVERY email AQUIQ sends from no-reply: logo, name and a teal line on top, the body
// centred in Calibri 11. Only the inside (the words) differs per email; text versions are untouched.

const LOGO_URL = process.env.MAIL_LOGO_URL || 'https://aquiq-admin.vercel.app/email-logo.png';

// Some mail apps (Outlook especially) do not pass the centring down to each paragraph, so it is stamped on every one.
const centre = (inner) => String(inner)
  .replace(/<p style="(?!text-align)/g, '<p style="text-align:center;')   // a paragraph that already sets its own alignment keeps it
  .replace(/<div style="(?!background|max-width)/g, '<div style="text-align:center;');

const wrapHtml = (inner0) => { const inner = centre(inner0); return `<div style="background:#eef1f5;padding:24px 12px">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px 28px;text-align:center;font-family:Calibri,Carlito,Arial,sans-serif;font-size:11pt;line-height:1.6;color:#1b2a41">
<img src="${LOGO_URL}" width="84" alt="AQUIQ by PR SONS" style="display:block;margin:0 auto 8px">
<div style="font-size:22px;font-weight:bold;letter-spacing:2px;color:#0b2545">AQUIQ</div>
<div style="font-size:11pt;color:#5b6b82;margin-bottom:14px">by PR SONS</div>
<hr style="border:none;border-top:2px solid #13a8a8;width:60%;margin:0 auto 22px">
${inner}
</div>
</div>`; };

// Short mails (login / confirmation codes): same layout around a few centred lines.
const simpleHtml = (paragraphs) => wrapHtml(
  paragraphs.map((p, i) => `<p style="margin:0 0 ${i === paragraphs.length - 1 ? 0 : 14}px">${p}</p>`).join('\n'));

module.exports = { wrapHtml, simpleHtml, LOGO_URL };
