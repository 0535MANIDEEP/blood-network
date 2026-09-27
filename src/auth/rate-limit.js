/**
 * Login throttling.
 *
 * Password hashing is deliberately slow, which means an unthrottled login
 * endpoint is a free way to make the server burn CPU. This is the cheapest
 * defence in the system and the one most often left out of student projects.
 *
 * Scope limit, stated plainly: this is per process and in memory. It stops the
 * casual and the automated-against-one-instance case. It does not stop a
 * distributed one, and it resets on restart. A multi-instance deployment needs
 * this in Redis or Postgres; until then it is a speed bump, not a wall, and
 * anything claiming otherwise would be overstating it.
 */

/** Keyed by phone for per account, and by client address for per source. */
const POLICIES = Object.freeze({
  account: Object.freeze({ limit: 5, windowMs: 15 * 60_000 }),
  source: Object.freeze({ limit: 25, windowMs: 15 * 60_000 }),
});

/**
 * Progressive delay: each further failure inside a window costs more, up to a
 * ceiling. This punishes guessing far harder than a flat counter, because after
 * the fifth attempt a script is already waiting minutes per try.
 */
const DELAY_STEPS_MS = Object.freeze([0, 0, 1_000, 5_000, 30_000, 120_000]);
const MAX_DELAY_MS = DELAY_STEPS_MS[DELAY_STEPS_MS.length - 1];

export class LoginThrottle {
  #account = new Map();
  #source = new Map();

  #sweep(bucket, now) {
    for (const [key, entry] of bucket) {
      if (now - entry.first > entry.policy.windowMs) bucket.delete(key);
    }
  }

  #stateFor(bucket, key, policy) {
    const now = Date.now();
    this.#sweep(bucket, now);

    const existing = bucket.get(key);
    if (existing && now - existing.first <= policy.windowMs) return existing;

    const fresh = { count: 0, first: now, policy };
    bucket.set(key, fresh);
    return fresh;
  }

  /**
   * Record a failed attempt against both the account and the source address.
   * Both are recorded because either alone is bypassable: per account lets one
   * source grind many accounts, per source lets one account be attacked from
   * many addresses.
   */
  recordFailure({ phone, source }) {
    const now = Date.now();
    const account = this.#stateFor(this.#account, String(phone), POLICIES.account);
    const origin = this.#stateFor(this.#source, String(source ?? 'unknown'), POLICIES.source);

    account.count += 1;
    origin.count += 1;

    return {
      retryAfterMs: this.#delayFor(account),
      accountAttempts: account.count,
      sourceAttempts: origin.count,
    };
  }

  #delayFor(entry) {
    const step = DELAY_STEPS_MS[Math.min(entry.count, DELAY_STEPS_MS.length - 1)];
    return Math.min(step, MAX_DELAY_MS);
  }

  /**
   * Whether a login may be attempted right now.
   * Called before any hashing, so a blocked caller costs almost nothing.
   */
  check({ phone, source }) {
    const now = Date.now();

    const account = this.#account.get(String(phone));
    const origin = this.#source.get(String(source ?? 'unknown'));

    for (const entry of [account, origin]) {
      if (!entry) continue;
      if (now - entry.first > entry.policy.windowMs) continue;
      if (entry.count >= entry.policy.limit) {
        const resetsInMs = entry.policy.windowMs - (now - entry.first);
        return {
          allowed: false,
          retryAfterMs: Math.max(this.#delayFor(entry), resetsInMs),
          reason: 'too_many_attempts',
        };
      }
    }

    return { allowed: true, retryAfterMs: 0, reason: 'ok' };
  }

  /** A correct password clears the account counter, not the source counter. */
  recordSuccess({ phone }) {
    this.#account.delete(String(phone));
  }

  /**
   * Whether a successful login is plausible for this caller.
   *
   * A source address that has failed many different accounts is either an
   * attack or a shared NAT such as a hospital or a college, and the two are not
   * distinguishable from here. It is reported rather than acted on, because
   * blocking an entire hospital on suspicion would be worse than the problem.
   */
  sourceRisk({ source }) {
    const origin = this.#source.get(String(source ?? 'unknown'));
    if (!origin) return { level: 'none', attempts: 0 };
    if (origin.count >= POLICIES.source.limit) return { level: 'high', attempts: origin.count };
    if (origin.count >= POLICIES.source.limit / 2) return { level: 'elevated', attempts: origin.count };
    return { level: 'low', attempts: origin.count };
  }

  /** Test and development helper. */
  reset() {
    this.#account.clear();
    this.#source.clear();
  }
}

/** A shared instance for the process. */
export const loginThrottle = new LoginThrottle();
