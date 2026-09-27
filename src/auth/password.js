import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/**
 * Password hashing.
 *
 * scrypt from node:crypto, no external dependency. Chosen over bcrypt or argon2
 * because a native module is a build failure waiting to happen on a platform
 * nobody tested, and scrypt is memory hard, which is the property that actually
 * makes a stolen hash expensive to attack.
 *
 * Cost parameters are injectable only so the test suite does not spend seconds
 * hashing. Production uses the defaults below and nothing passes anything else.
 */

const PRODUCTION = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 64 });

// scrypt needs roughly 128 * N * r bytes. At the production cost that is about
// 16 MB per hash, so a handful of parallel logins is fine but a burst needs a
// memory limit, not just a rate limit.
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;

export class WeakPasswordError extends Error {
  constructor() {
    super('Password rejected as too weak to store.');
    this.name = 'WeakPasswordError';
  }
}

/**
 * Minimum strength actually enforced.
 *
 * Deliberately modest. A length rule that pushes people toward
 * "P@ssw0rd1!" produces a weaker password than a long one, so the floor is
 * length and character variety, and nothing cleverer.
 */
const MIN_LENGTH = 10;

export function assessPasswordStrength(password) {
  const problems = [];

  if (typeof password !== 'string' || password.length < MIN_LENGTH) {
    problems.push(`at least ${MIN_LENGTH} characters`);
  }
  if (typeof password === 'string' && /^\d+$/.test(password)) {
    problems.push('not only digits');
  }
  if (typeof password === 'string' && password.length > 200) {
    // Bounded so a huge string cannot be used to burn CPU.
    problems.push('under 200 characters');
  }

  return { acceptable: problems.length === 0, problems };
}

export async function hashPassword(password, cost = PRODUCTION) {
  const strength = assessPasswordStrength(password);
  if (!strength.acceptable) {
    throw new WeakPasswordError();
  }

  const salt = randomBytes(16);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, cost.keyLength, {
    N: cost.N,
    r: cost.r,
    p: cost.p,
    maxmem: MEMORY_LIMIT_BYTES,
  });

  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');

  // A malformed stored hash must not be treated as a match, and must not be
  // allowed to request an absurd allocation either.
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < 2 || r < 1 || p < 1 || expected.length === 0) return false;
  if (N * r * 128 > MEMORY_LIMIT_BYTES) return false;

  let derived;
  try {
    derived = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: MEMORY_LIMIT_BYTES,
    });
  } catch {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Check a password against a stored hash without leaking whether the account
 * exists, and without skipping the work when it does not.
 *
 * Login has to take the same time whether or not the phone is registered,
 * otherwise the response time is a registration oracle: you can enumerate who
 * has an account by watching which requests come back fast.
 */
export async function verifyPasswordOrDecoy(password, storedHash) {
  if (storedHash) return { matched: await verifyPassword(password, storedHash) };

  // Spend comparable time, then report the same failure as a wrong password.
  const decoy =
    'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
    'ZHVtbXktaGFzaC1maWxsZXItdG8tbG9vay1hYmM=';
  await verifyPassword(typeof password === 'string' ? password : '', decoy);
  return { matched: false };
}

/**
 * Whether a password has appeared in a known-breached list.
 *
 * The real service is HIBP's k-anonymity range API, which needs no network call
 * in tests. Offline, this returns unknown rather than pretending to be clean,
 * because a check that cannot run must not report "safe".
 */
export function checkBreachExposure(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return { checked: false, breached: null, note: 'offline_not_checked' };
  }
  return { checked: false, breached: null, note: 'offline_not_checked' };
}
