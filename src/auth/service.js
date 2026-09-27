import {
  hashPassword,
  verifyPasswordOrDecoy,
  assessPasswordStrength,
  WeakPasswordError,
} from './password.js';
import {
  mintToken,
  hashToken,
  sessionExpiry,
  evaluateSession,
  tokensMatch,
  DEFAULT_IDLE_MINUTES,
  DEFAULT_ABSOLUTE_HOURS,
} from './session.js';
import { loginThrottle } from './rate-limit.js';
import { subjectIdFor } from './rbac.js';

const RESET_TTL_MINUTES = 30;

/**
 * Account lifecycle.
 *
 * Two decisions here that are easy to get wrong and expensive to get wrong later:
 *
 *   Self registering a bank creates it UNVERIFIED. There is no code path in
 *   which a signup makes a bank usable for supply, because "supplyable blood" is
 *   exactly the claim that has to be backed by a licence check. An unverified
 *   bank can hold stock and can be listed, but reserveStock refuses it.
 *
 *   Completing a password reset revokes every existing session. Without that, a
 *   reset is not a recovery from a compromised account, it is a way to change
 *   the password while the attacker's cookie keeps working.
 */

/** Indian mobile numbers, which is the intended deployment. */
export function normalisePhone(raw) {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  return null;
}

export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

const GENERIC_LOGIN_FAILURE = 'Phone number or password is incorrect.';

/**
 * Create an account, and the donor or bank record it acts as, atomically.
 *
 * One transaction because a half created account is worse than none: a user row
 * pointing at a donor row that was never inserted fails the role constraint, and
 * a donor row with no way to log in is a person who thinks they registered and
 * cannot.
 */
export async function registerAccount(db, input, options = {}) {
  const {
    phone: rawPhone,
    password,
    displayName,
    role,
    bloodGroup,
    city = '',
    state = '',
    bankName,
    throttle = loginThrottle,
    source,
  } = input;

  const phone = normalisePhone(rawPhone);
  if (!phone) throw new AuthError('Enter a valid 10 digit mobile number.', 'bad_phone');
  if (typeof displayName !== 'string' || displayName.trim().length < 2) {
    throw new AuthError('Enter your name.', 'bad_name');
  }
  if (!['donor', 'bank', 'coordinator'].includes(role)) {
    throw new AuthError('Unknown account type.', 'bad_role');
  }
  // Coordinator accounts cannot be self registered. They are the ones who verify
  // banks, so letting anyone mint one would make the whole verification step
  // decorative.
  if (role === 'coordinator') {
    throw new AuthError('Coordinator accounts are created by an administrator.', 'role_not_self_serve');
  }

  const strength = assessPasswordStrength(password);
  if (!strength.acceptable) {
    throw new WeakPasswordError();
  }

  const gate = throttle.check({ phone, source });
  if (!gate.allowed) {
    throw new AuthError(`Too many attempts. Try again in ${Math.ceil(gate.retryAfterMs / 1000)}s.`, 'throttled');
  }

  const existing = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
  if (existing.length > 0) {
    throttle.recordFailure({ phone, source });
    // Deliberately the same message as a bad password, so registering does not
    // confirm which numbers have accounts.
    throw new AuthError(GENERIC_LOGIN_FAILURE, 'unavailable');
  }

  const passwordHash = await hashPassword(password, options.passwordCost);

  const created = await db.transaction(async (tx) => {
    let donorId = null;
    let bankId = null;

    if (role === 'donor') {
      const donor = await tx.query(
        `INSERT INTO donors (name, phone, blood_group, city, state)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [displayName.trim(), phone, bloodGroup, city, state],
      );
      donorId = donor[0].id;
    }

    if (role === 'bank') {
      if (typeof bankName !== 'string' || bankName.trim().length < 2) {
        throw new AuthError('Enter the blood bank name.', 'bad_bank_name');
      }
      // verified_at is deliberately omitted. Supplying blood is a licensed act
      // and this signup is not evidence of a licence.
      const bank = await tx.query(
        `INSERT INTO banks (name, phone, city, state) VALUES ($1, $2, $3, $4) RETURNING id`,
        [bankName.trim(), phone, city, state],
      );
      bankId = bank[0].id;
    }

    const user = await tx.query(
      `INSERT INTO users (phone, password_hash, role, display_name, donor_id, bank_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, role, display_name, phone, donor_id, bank_id, created_at`,
      [phone, passwordHash, role, displayName.trim(), donorId, bankId],
    );

    return user[0];
  });

  throttle.recordSuccess({ phone });

  return {
    user: toPublicUser(created),
    donorId: created.donor_id,
    bankId: created.bank_id,
    // A bank that just signed up exists but cannot supply until verified.
    pendingVerification: role === 'bank',
  };
}

export async function login(db, { phone: rawPhone, password, source, userAgent }, options = {}) {
  const phone = normalisePhone(rawPhone);
  const throttle = options.throttle ?? loginThrottle;

  if (!phone) {
    throw new AuthError(GENERIC_LOGIN_FAILURE, 'bad_credentials');
  }

  const gate = throttle.check({ phone, source });
  if (!gate.allowed) {
    throw new AuthError(
      `Too many attempts. Try again in ${Math.ceil(gate.retryAfterMs / 1000)}s.`,
      'throttled',
    );
  }

  const rows = await db.query(
    'SELECT id, phone, password_hash, role, display_name, donor_id, bank_id, disabled_at FROM users WHERE phone = $1',
    [phone],
  );
  const user = rows[0];

  // Runs the scrypt work whether or not the account exists, so response time
  // does not reveal which phone numbers are registered.
  const { matched } = await verifyPasswordOrDecoy(password, user?.password_hash);

  if (!user || !matched) {
    throttle.recordFailure({ phone, source });
    throw new AuthError(GENERIC_LOGIN_FAILURE, 'bad_credentials');
  }

  if (user.disabled_at) {
    // Counted as a failure, and reported generically, so a disabled account is
    // not distinguishable from a wrong password by an outsider.
    throttle.recordFailure({ phone, source });
    throw new AuthError(GENERIC_LOGIN_FAILURE, 'bad_credentials');
  }

  throttle.recordSuccess({ phone });

  const token = mintToken();
  const now = new Date();
  const expiry = sessionExpiry(now, options.expiry);

  await db.query(
    `INSERT INTO sessions
       (user_id, token_hash, idle_expires_at, absolute_expires_at, user_agent, source_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user.id, hashToken(token), expiry.idleExpiresAt, expiry.absoluteExpiresAt, userAgent ?? null, source ?? null],
  );

  return { token, expiresAt: expiry.absoluteExpiresAt, user: toPublicUser(user), risk: throttle.sourceRisk({ source }) };
}

/**
 * Resolve a cookie into a user.
 *
 * The idle window slides forward on each use but is clamped to the absolute
 * expiry, so activity cannot extend a session past its cap.
 */
export async function resolveSession(db, token, now = new Date(), { idleMinutes = DEFAULT_IDLE_MINUTES } = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    return { authenticated: false, reason: 'no_token' };
  }

  const rows = await db.query(
    `SELECT s.id, s.user_id, s.token_hash, s.created_at, s.last_seen_at,
            s.idle_expires_at, s.absolute_expires_at, s.revoked_at,
            u.phone, u.role, u.display_name, u.donor_id, u.bank_id, u.disabled_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [hashToken(token)],
  );

  if (rows.length === 0) return { authenticated: false, reason: 'no_session' };

  const row = rows[0];

  // Defence in depth against a database that somehow stored a plain token.
  if (!tokensMatch(row.token_hash, hashToken(token))) {
    return { authenticated: false, reason: 'no_session' };
  }

  const state = evaluateSession(row, now);
  if (!state.valid) {
    // Record the reason on the row so a revoked session is distinguishable from
    // a mistyped cookie in the logs.
    if (state.reason === 'revoked' && !row.revoked_at) {
      await db.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1', [row.id, now]);
    }
    return { authenticated: false, reason: state.reason };
  }

  if (row.disabled_at) {
    return { authenticated: false, reason: 'account_disabled' };
  }

  const nextIdle = new Date(
    Math.min(now.getTime() + idleMinutes * 60_000, new Date(row.absolute_expires_at).getTime()),
  );

  await db.query('UPDATE sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1', [
    row.id,
    now,
    nextIdle,
  ]);

  return {
    authenticated: true,
    sessionId: row.id,
    user: toPublicUser(row),
    // Forwarded so the caller can log a session that has outlived the policy.
    suspiciousAge: state.suspiciousAge,
  };
}

export async function logout(db, token) {
  if (typeof token !== 'string' || token.length === 0) return { revoked: false };
  const rows = await db.query(
    'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id',
    [hashToken(token)],
  );
  return { revoked: rows.length > 0 };
}

/** Revoke every live session for a user. Used on password change and on disable. */
export async function revokeAllSessions(db, userId) {
  const rows = await db.query(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id',
    [userId],
  );
  return { revoked: rows.length };
}

/**
 * Start a password reset.
 *
 * The response is identical whether or not the account exists. The token is only
 * returned when a delivery callback is supplied, which is how tests can complete
 * the flow without a message gateway, and how production hands the link to a
 * real channel.
 */
export async function requestPasswordReset(db, { phone: rawPhone, source, deliver } = {}) {
  const phone = normalisePhone(rawPhone);
  const response = { accepted: true, sent: false };

  if (!phone) return response;

  const rows = await db.query('SELECT id FROM users WHERE phone = $1 AND disabled_at IS NULL', [phone]);
  if (rows.length === 0) return response;

  const token = mintToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESET_TTL_MINUTES * 60_000);

  // Only the newest request stays valid, so asking twice retires the older link.
  await db.query(
    'UPDATE password_resets SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL',
    [rows[0].id, now],
  );

  await db.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at, source_address)
     VALUES ($1, $2, $3, $4)`,
    [rows[0].id, hashToken(token), expiresAt, source ?? null],
  );

  if (typeof deliver === 'function') {
    await deliver({ token, expiresAt, phone });
    response.sent = true;
  }

  return response;
}

export async function completePasswordReset(db, { token, password }, options = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new AuthError('That reset link is not valid.', 'bad_reset_token');
  }

  const strength = assessPasswordStrength(password);
  if (!strength.acceptable) throw new WeakPasswordError();

  const rows = await db.query(
    `SELECT id, user_id FROM password_resets
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2`,
    [hashToken(token), new Date()],
  );

  if (rows.length === 0) {
    throw new AuthError('That reset link has expired or already been used.', 'bad_reset_token');
  }

  const passwordHash = await hashPassword(password, options.passwordCost);

  const userId = await db.transaction(async (tx) => {
    const update = await tx.query(
      'UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id',
      [rows[0].user_id, passwordHash],
    );
    if (update.length === 0) throw new AuthError('That reset link is not valid.', 'bad_reset_token');

    await tx.query('UPDATE password_resets SET used_at = $2 WHERE id = $1', [rows[0].id, new Date()]);

    // The point of a reset. The old cookie must stop working.
    await tx.query('UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [
      rows[0].user_id,
      new Date(),
    ]);

    return update[0].id;
  });

  return { passwordChanged: true, sessionsRevoked: true, userId };
}

/** Never leak the password hash or the linked ids to a client. */
export function toPublicUser(row) {
  return {
    id: row.id,
    phone: row.phone,
    role: row.role,
    displayName: row.display_name,
    subjectId: subjectIdFor(row),
  };
}
