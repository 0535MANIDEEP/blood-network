import { tooManyRequests } from './errors.js';

/**
 * Rate limiting for endpoints that anyone can reach.
 *
 * Login throttling lives in the auth module because it needs to reason about
 * accounts. This one is simpler and exists for a different reason: requests can
 * be raised without an account, on purpose, because making someone create a
 * password during a medical emergency is the wrong trade. That decision has a
 * cost, and the cost is an unauthenticated write endpoint on the public
 * internet. This is where that cost is paid.
 *
 * Without it, the endpoint that accepts "I need 2 units of O negative at Apollo
 * tonight" from anyone is a spam relay and a way to harass every bank and donor
 * in the database.
 *
 * Same scope limit as the login limiter: per process, in memory, reset on
 * restart. Enough to stop casual abuse and single-source automated abuse. Not
 * enough for a distributed one.
 */

const DEFAULT_POLICY = Object.freeze({ limit: 30, windowMs: 60_000 });

export class RateLimiter {
  #buckets = new Map();
  #policy;

  constructor(policy = {}) {
    this.#policy = { ...DEFAULT_POLICY, ...policy };
  }

  #sweep(now) {
    for (const [key, entry] of this.#buckets) {
      if (now - entry.start >= this.#policy.windowMs) this.#buckets.delete(key);
    }
  }

  /**
   * Count one hit and report whether it is over the limit.
   *
   * Counts the request even when it is over, so a client that keeps hammering
   * cannot reset its own window by spacing requests out.
   */
  hit(key) {
    const now = Date.now();
    this.#sweep(now);

    const id = String(key);
    let entry = this.#buckets.get(id);

    if (!entry) {
      entry = { count: 0, start: now };
      this.#buckets.set(id, entry);
    }

    entry.count += 1;

    if (entry.count > this.#policy.limit) {
      const retryAfterMs = this.#policy.windowMs - (now - entry.start);
      return { allowed: false, remaining: 0, retryAfterMs };
    }

    return {
      allowed: true,
      remaining: this.#policy.limit - entry.count,
      retryAfterMs: 0,
    };
  }

  reset() {
    this.#buckets.clear();
  }
}

/** Keyed by client address, so one caller cannot spend another's budget. */
export function clientKey(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    // Only the first hop, and only because a reverse proxy sets this. A client
    // that can set the header itself defeats the limiter, so a deployment behind
    // a proxy must strip it rather than pass it through.
    return forwarded.split(',')[0].trim();
  }
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

export function requestLimiter(options) {
  const limiter = new RateLimiter(options);

  return (req, res, next) => {
    const result = limiter.hit(clientKey(req));

    res.set('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      // A proper ApiError, not a bare object. Handing next() something the error
      // handler does not recognise turns a rate limit into a 500, and a client
      // that sees 500 retries immediately, which is the opposite of what the
      // limit was for.
      res.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      next(
        tooManyRequests(
          'Too many requests from this address. Wait a moment and try again.',
          result.retryAfterMs,
        ),
      );
      return;
    }

    next();
  };
}
