import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Session tokens.
 *
 * The token is 256 bits of randomness, base64url encoded. It is handed to the
 * client in an HttpOnly cookie and never read by JavaScript, so an XSS bug
 * cannot exfiltrate a live session.
 *
 * Only the SHA-256 of the token is stored. A stolen database therefore yields
 * hashes that cannot be replayed as cookies, which is the whole reason sessions
 * are not kept as plaintext rows. SHA-256 rather than a slow KDF is correct here
 * precisely because the input is already 256 bits of entropy: there is no
 * dictionary to attack, so slowness would only waste time on the login path.
 *
 * Two expiries, not one. Absolute expiry caps how long a stolen cookie is worth
 * however active the holder is. Idle expiry ends sessions nobody is using. A
 * token with only a sliding window can be kept alive forever by whoever stole it.
 */

export const TOKEN_BYTES = 32;
export const DEFAULT_IDLE_MINUTES = 60 * 24 * 7; // 7 days
export const DEFAULT_ABSOLUTE_HOURS = 24 * 30; // 30 days

/** Longer than any legitimate session, so it can only mean a stolen cookie. */
export const SUSPICIOUS_ABSOLUTE_HOURS = 24 * 90;

export function mintToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Two hashes of equal length are compared in constant time.
 *
 * Used for the cases where a token is compared rather than looked up, so that
 * the comparison itself does not leak how many leading characters were right.
 */
export function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  // Both sides must be well formed hex of the sha256 length. Buffer.from with
  // 'hex' silently stops at the first invalid character, so 'abc' and 'abc'
  // would otherwise decode to the same single byte and compare equal, and a
  // corrupted stored hash would then be treated as a match.
  if (!/^[0-9a-f]{64}$/i.test(a) || !/^[0-9a-f]{64}$/i.test(b)) return false;

  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export function sessionExpiry(now = new Date(), { idleMinutes = DEFAULT_IDLE_MINUTES, absoluteHours = DEFAULT_ABSOLUTE_HOURS } = {}) {
  return {
    // Idle window slides forward on each use, but never past the absolute cap,
    // so a long lived session still dies on schedule.
    idleExpiresAt: new Date(now.getTime() + idleMinutes * 60_000),
    absoluteExpiresAt: new Date(now.getTime() + absoluteHours * 3_600_000),
  };
}

/**
 * Whether a session row is still usable, and if not, why.
 *
 * The reason is returned rather than a bare boolean because a revoked or
 * expired session needs a different response from a missing one, and a system
 * that cannot tell them apart ends up revoking everything when it should
 * refresh one.
 */
export function evaluateSession(session, now = new Date()) {
  if (!session) return { valid: false, reason: 'no_session' };
  if (session.revoked_at) return { valid: false, reason: 'revoked' };

  const absolute = new Date(session.absolute_expires_at);
  if (Number.isNaN(absolute.getTime()) || absolute <= now) {
    return { valid: false, reason: 'expired_absolute' };
  }

  const idle = new Date(session.idle_expires_at);
  if (Number.isNaN(idle.getTime()) || idle <= now) {
    return { valid: false, reason: 'expired_idle' };
  }

  const ageHours = (now - new Date(session.created_at)) / 3_600_000;
  return {
    valid: true,
    reason: 'ok',
    // Surfaced so the auth layer can log it rather than quietly allow a session
    // far older than the policy intends.
    suspiciousAge: ageHours > SUSPICIOUS_ABSOLUTE_HOURS,
    ageHours,
  };
}

/**
 * Cookie serialisation.
 *
 * Secure and SameSite are set unconditionally. Over plain http a Secure cookie
 * is dropped rather than sent, which is the correct failure: it means a local
 * http deployment loses sessions instead of transmitting them in the clear, and
 * losing a session is a far smaller problem than leaking one.
 */
export function sessionCookie(token, { maxAgeSeconds = DEFAULT_ABSOLUTE_HOURS * 3600, secure = true } = {}) {
  const parts = [
    `bn_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie() {
  return 'bn_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

/** Read the token out of a Cookie header. Absent or malformed yields null. */
export function readSessionCookie(header) {
  if (typeof header !== 'string' || header.length === 0) return null;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    if (part.slice(0, index).trim() !== 'bn_session') continue;

    const value = part.slice(index + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}
