/**
 * Magic-link minting for the hyper-gate dashboard gate.
 *
 * Produces the one-time, short-lived token the gate redeems at
 * hyper.shtanga.xyz/auth. The signing scheme MUST stay byte-for-byte compatible
 * with hyper_gate/src/crypto.js verifyToken() — same HMAC-SHA256, same "t1."
 * prefix, same base64url, same {cid, exp, n} payload. Keep the two in sync.
 */

const enc = new TextEncoder();

function b64url(str) {
  const bytes = enc.encode(str);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  let s = '';
  const bytes = new Uint8Array(sig);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const TOKEN_TTL = 300; // 5 minutes — one tap of /dashboard mints a fresh one

/** Build the full magic-link URL for a verified member. */
export async function makeDashboardLink(secret, origin, chatId) {
  const payload = { cid: chatId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL, n: crypto.randomUUID() };
  const msg = 't1.' + b64url(JSON.stringify(payload));
  const token = msg + '.' + (await sign(secret, msg));
  return `${origin}/auth?t=${token}`;
}
