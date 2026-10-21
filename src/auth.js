const crypto = require('node:crypto');

const SCRYPT_KEYLEN = 64;
const ROOM_COOKIE_PREFIX = 'wc_room_';
const ROOM_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const [, salt, expectedHex] = parts;
  if (!/^[0-9a-f]+$/i.test(expectedHex)) return false;

  let expected;
  let actual;
  try {
    expected = Buffer.from(expectedHex, 'hex');
    actual = crypto.scryptSync(String(password), salt, expected.length);
  } catch {
    return false;
  }
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Changing the password changes this fingerprint, which invalidates every
// previously issued room cookie without needing a separate revocation list.
function passwordFingerprint(passwordHash) {
  return crypto.createHash('sha256').update(String(passwordHash)).digest('hex').slice(0, 16);
}

function roomCookieName(roomId) {
  return `${ROOM_COOKIE_PREFIX}${roomId}`;
}

function signRoomToken(roomId, passwordHash, secret, ttlMs = ROOM_SESSION_TTL_MS) {
  const expiresAt = Date.now() + ttlMs;
  const payload = `${roomId}.${expiresAt}.${passwordFingerprint(passwordHash)}`;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${expiresAt}.${signature}`;
}

function verifyRoomToken(roomId, token, passwordHash, secret) {
  if (!token || !passwordHash || !secret) return false;

  const parts = String(token).split('.');
  if (parts.length !== 2) return false;

  const expiresAt = Number(parts[0]);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;

  const payload = `${roomId}.${expiresAt}.${passwordFingerprint(passwordHash)}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const given = parts[1];
  if (!/^[0-9a-f]+$/i.test(given) || given.length !== expected.length) return false;

  const givenBuf = Buffer.from(given, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  return givenBuf.length === expectedBuf.length && crypto.timingSafeEqual(givenBuf, expectedBuf);
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;

  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    const value = part.slice(eq + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

module.exports = {
  ROOM_SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  roomCookieName,
  signRoomToken,
  verifyRoomToken,
  parseCookies
};
