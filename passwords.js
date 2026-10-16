'use strict';
// Password storage for company (UHAD) accounts: a salted scrypt hash, never the password itself.
const crypto = require('crypto');

const N = 16384;
const KEYLEN = 32;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, { N });
  return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [kind, n, salt, hash] = String(stored || '').split('$');
    if (kind !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), want.length, { N: Number(n) });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch { return false; }
}

// at least 8 characters, with a letter and a digit
function strongEnough(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 72 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
}

function sameText(a, b) {          // constant-time compare for the legacy plain-text passwords
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { hashPassword, verifyPassword, strongEnough, sameText };
