/**
 * API errors.
 *
 * RFC 7807 problem details, because a machine-readable error type is worth more
 * than a prose string when a client has to decide between "show a retry button"
 * and "tell the user their input was wrong".
 *
 * The rule that matters: a 500 never carries an internal message. A stack trace
 * or a Postgres error in a response body tells an attacker the schema, the
 * driver version and the file layout, and there is no user-facing benefit to it.
 */

export class ApiError extends Error {
  constructor(status, { type, title, detail, extra } = {}) {
    super(detail ?? title ?? 'Request failed');
    this.name = 'ApiError';
    this.status = status;
    this.type = type ?? 'about:blank';
    this.title = title ?? 'Request failed';
    this.extra = extra;
  }

  toProblem() {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      detail: this.message,
      ...this.extra,
    };
  }
}

export const badRequest = (detail, extra) =>
  new ApiError(400, { type: 'urn:problem:invalid', title: 'Invalid request', detail, extra });

export const unauthenticated = (detail = 'Sign in to continue.') =>
  new ApiError(401, { type: 'urn:problem:unauthenticated', title: 'Sign in required', detail });

export const forbidden = (detail = 'You do not have access to this.') =>
  new ApiError(403, { type: 'urn:problem:forbidden', title: 'Not permitted', detail });

export const notFound = (detail = 'Not found.') =>
  new ApiError(404, { type: 'urn:problem:not-found', title: 'Not found', detail });

export const conflict = (detail, extra) =>
  new ApiError(409, { type: 'urn:problem:conflict', title: 'Conflict', detail, extra });

export const tooManyRequests = (detail, retryAfterMs = 1000) =>
  new ApiError(429, {
    type: 'urn:problem:rate-limited',
    title: 'Too many requests',
    detail,
    extra: { retryAfterMs, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) },
  });

export const serverError = () =>
  new ApiError(500, {
    type: 'urn:problem:internal',
    title: 'Something went wrong',
    // Deliberately opaque. The real error goes to the log, not to the caller.
    detail: 'The request could not be completed. Please try again.',
  });
