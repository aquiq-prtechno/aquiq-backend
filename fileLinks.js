'use strict';
// Short-lived signed links for files the server builds on request (nothing is stored for them):
//   /files/report/<token>     a service report PDF rebuilt from the saved details
//   /files/visit-log/<token>  the customer's visit log as Excel or PDF
const crypto = require('crypto');

const secret = () => process.env.LINK_SECRET || process.env.SUPABASE_SERVICE_KEY || 'aquiq-dev-link-secret';
const b64 = (b) => Buffer.from(b).toString('base64url');
const mac = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

function sign(payload, seconds = 900, now = Date.now()) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + seconds }));
  return `${body}.${mac(body)}`;
}

function verify(token, now = Date.now()) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = mac(body);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp && p.exp * 1000 >= now ? p : null;
  } catch { return null; }
}

const baseUrl = () => (process.env.PUBLIC_BASE_URL || 'https://web-production-85fd6.up.railway.app').replace(/\/$/, '');

module.exports = { sign, verify, baseUrl };
