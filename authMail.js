'use strict';
// The sign-in emails for the admin panel (invite and forgot password), built here so they always use the
// AQUIQ layout and send from no-reply, instead of depending on the Supabase email templates.
const { wrapHtml } = require('./mailLayout');

const HELP = 'careaquiq-prsons@aquiq-prsons.com';
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FOOT = `Need help? Write to ${HELP}\nThis is an automated message from no-reply@aquiq-prsons.com. Please do not reply.`;
const button = (link, label) => `<p style="margin:0 0 24px"><a href="${esc(link)}" style="background:#0b2545;color:#ffffff;text-decoration:none;padding:12px 30px;border-radius:6px;font-weight:bold;display:inline-block">${label}</a></p>`;
const small = (t, b = 8) => `<p style="font-size:10pt;color:#5b6b82;margin:0 0 ${b}px">${t}</p>`;
const footerHtml = `<hr style="border:none;border-top:1px solid #dde3ea;margin:0 0 12px">\n<p style="font-size:9pt;color:#8693a5;margin:0">Need help? Write to ${HELP}<br>This is an automated message from no-reply@aquiq-prsons.com. Please do not reply.</p>`;

function inviteMail({ email, link }) {
  const text = ['Hello,', '', `You have been invited to the AQUIQ Admin Panel with the email ${email}.`, 'Open the link below to accept the invite and set your own password.', '', link, '',
    'The link works once and expires soon. If it has expired, ask the person who invited you to send a new one.', 'If you were not expecting this invite, ignore this email.', '', FOOT].join('\n');
  const html = wrapHtml([
    '<p style="margin:0 0 12px">Hello,</p>',
    `<p style="margin:0 0 22px">You have been invited to the AQUIQ Admin Panel with the email <b>${esc(email)}</b>.<br>Click the button below to accept the invite and set your own password.</p>`,
    button(link, 'Accept invite'),
    small('The link works once and expires soon. If it has expired, ask the person who invited you to send a new one.'),
    small('If you were not expecting this invite, ignore this email.', 22),
    footerHtml,
  ].join('\n'));
  return { subject: 'You have been invited to AQUIQ', text, html };
}

function resetMail({ email, link }) {
  const text = ['Hello,', '', `We received a request to reset the password for ${email}.`, 'Open the link below to choose a new password.', '', link, '',
    'This link works once and expires soon. If it has expired, go back to the sign-in page and click "Forgot password?" again.', 'If you did not ask for this, ignore this email. Your password will not change.',
    'If your account has been frozen by the owner, you will not be able to sign in even after resetting. Please contact the owner.', '', FOOT].join('\n');
  const html = wrapHtml([
    '<p style="margin:0 0 12px">Hello,</p>',
    `<p style="margin:0 0 22px">We received a request to reset the password for <b>${esc(email)}</b>.<br>Click the button below to choose a new password.</p>`,
    button(link, 'Reset my password'),
    small('This link works once and expires soon. If it has expired, go back to the sign-in page and click "Forgot password?" again.'),
    small('If you did not ask for this, ignore this email. Your password will not change.'),
    small('If your account has been frozen by the owner, you will not be able to sign in even after resetting. Please contact the owner.', 22),
    footerHtml,
  ].join('\n'));
  return { subject: 'Reset your AQUIQ password', text, html };
}

// A small in-memory limiter: at most `max` uses of one key inside `windowMs`.
function createLimiter(max, windowMs, now = () => Date.now()) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const recent = (hits.get(key) || []).filter(x => t - x < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(t); hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(x => t - x < windowMs)) hits.delete(k);
    return true;
  };
}

module.exports = { inviteMail, resetMail, createLimiter };
