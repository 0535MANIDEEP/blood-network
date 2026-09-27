import { z } from 'zod';

import { resolveSession } from '../auth/service.js';
import { readSessionCookie } from '../auth/session.js';
import { UnauthenticatedError, ForbiddenError } from '../auth/rbac.js';
import { WeakPasswordError } from '../auth/password.js';
import { AuthError } from '../auth/service.js';
import { InsufficientStockError, BankNotVerifiedError } from '../db/inventory.js';
import { assertNoClinicalClaim } from '../policy/boundary.js';
import * as errors from './errors.js';

/**
 * Request pipeline pieces.
 *
 * Two rules run through all of it:
 *
 *   Nothing from a request body is trusted. Every route validates with a schema
 *   and reads the parsed result, never req.body, so a field that is missing from
 *   the schema cannot be smuggled through by a client that sends it anyway.
 *
 *   Internal errors are never shown. An unexpected exception becomes a generic
 *   500, because a Postgres message in a response body is a free map of the
 *   schema, the driver and the file layout.
 */

/**
 * Attach the session if there is one. Never rejects.
 *
 * Optional on purpose: public request raising and reading work without an
 * account, and a middleware that demanded one would undo that decision.
 */
export function attachSession({ db, idleMinutes } = {}) {
  return async (req, _res, next) => {
    try {
      const token = readSessionCookie(req.headers.cookie);
      req.session = await resolveSession(db, token, new Date(), { idleMinutes });
      req.user = req.session?.authenticated ? req.session.user : null;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireAuth(req, _res, next) {
  if (!req.user) {
    next(errors.unauthenticated());
    return;
  }
  next();
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) {
      next(errors.unauthenticated());
      return;
    }
    if (!roles.includes(req.user.role)) {
      // 403, not 404. Hiding existence from a signed in user who simply lacks the
      // role is theatre, and it makes debugging a permissions problem harder for
      // no security gain here, since the record is not sensitive by existence.
      next(errors.forbidden(`This action is for: ${roles.join(', ')}.`));
      return;
    }
    next();
  };
}

/**
 * Validate and replace the body.
 *
 * The parsed value REPLACES req.body, so a route physically cannot read a field
 * the schema did not declare. That is the point: forgetting to validate one
 * field is much easier than forgetting to not trust one field.
 */
export function validate(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      next(
        errors.badRequest('Some fields were not accepted.', {
          fieldErrors: result.error.issues.map((i) => ({
            field: i.path.join('.') || '(body)',
            problem: i.message,
          })),
        }),
      );
      return;
    }
    req.body = result.data;
    next();
  };
}

const UUID = z.string().uuid('must be a valid id');

/**
 * Validate and replace params. Same reasoning as validate() for the body.
 */
export function validateParams(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.params ?? {});
    if (!result.success) {
      next(errors.badRequest('That link is not valid.'));
      return;
    }
    req.params = result.data;
    next();
  };
}

const BLOOD_GROUP = z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']);
const URGENCY = z.enum(['routine', 'urgent', 'emergency']);
const ROLE = z.enum(['donor', 'bank']);

/** Coerce a form value or query string into a bounded integer. */
const boundedInt = (min, max) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? Number(v) : v),
    z.number().int().min(min).max(max),
  );

/**
 * Phone is required on an anonymous request, because the whole point of the
 * request is that somebody has to be contacted and nobody will ever see a
 * screen. Optional everywhere else, where the account already supplies one.
 */
const phone10 = z
  .string()
  .trim()
  .regex(/^\+?[\d\s-]{10,15}$/, 'must be a valid mobile number');

export const schemas = {
  register: z.object({
    phone: phone10,
    password: z.string().min(1, 'is required'),
    displayName: z.string().trim().min(2, 'is required').max(80),
    role: ROLE,
    bloodGroup: BLOOD_GROUP.optional(),
    city: z.string().trim().max(80).optional().default(''),
    state: z.string().trim().max(80).optional().default(''),
    // Collected from a bank signup because proximity is what decides which bank
    // gets asked first, and a bank with no coordinates can never be ranked.
    lat: z.number().min(-90).max(90).nullable().optional(),
    lon: z.number().min(-180).max(180).nullable().optional(),
    bankName: z.string().trim().min(2).max(120).optional(),
  }).refine((v) => v.role !== 'donor' || v.bloodGroup !== undefined, {
    message: 'A donor account needs a blood group',
    path: ['bloodGroup'],
  }).refine((v) => v.role !== 'bank' || Boolean(v.bankName), {
    message: 'A bank account needs the bank name',
    path: ['bankName'],
  }),

  login: z.object({
    phone: phone10,
    password: z.string().min(1, 'is required'),
  }),

  resetRequest: z.object({ phone: phone10 }),
  resetComplete: z.object({
    token: z.string().min(10, 'is required'),
    password: z.string().min(1, 'is required'),
  }),

  /**
   * Raising a request.
   *
   * No account required. unit count is capped at 20 because a request for 500
   * units is not a request, it is noise, and it would drag every donor in the
   * region into a queue that can never be filled.
   */
  raiseRequest: z.object({
    bloodGroup: BLOOD_GROUP,
    units: boundedInt(1, 20),
    urgency: URGENCY.optional().default('emergency'),
    hospital: z.string().trim().min(2, 'is required').max(160),
    city: z.string().trim().max(80).optional().default(''),
    state: z.string().trim().max(80).optional().default(''),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lon: z.number().min(-180).max(180).nullable().optional(),
    contactPhone: phone10,
    neededBy: z.string().datetime().nullable().optional(),
  }),

  requestId: z.object({ id: UUID }),
  bankId: z.object({ id: UUID }),

  /**
   * Partial by design. A donor withdrawing emergency contact is one field, and
   * making them resend their availability to do it is how an app ends up with
   * consent switches that people are afraid to touch because the form behind them
   * is fiddly. At least one field is required, so an empty PATCH is an error
   * rather than a silent no op.
   */
  setAvailability: z
    .object({
      available: z.boolean().optional(),
      // Consent is separate from availability on purpose. Someone happy to be
      // asked is not the same as someone who has agreed to be messaged at 2am,
      // and conflating them is how a donor ends up with a phone that rings
      // constantly.
      consentEmergency: z.boolean().optional(),
    })
    .refine((v) => v.available !== undefined || v.consentEmergency !== undefined, {
      message: 'Send available, consentEmergency, or both',
    }),

  setStock: z.object({
    bloodGroup: BLOOD_GROUP,
    units: boundedInt(0, 5000),
  }),

  reply: z.object({
    body: z.string().trim().min(1, 'cannot be empty').max(2000),
  }),

  listRequests: z.object({
    bloodGroup: BLOOD_GROUP.optional(),
    state: z.string().trim().max(80).optional(),
    city: z.string().trim().max(80).optional(),
    limit: boundedInt(1, 100).optional().default(50),
  }),

  verifyBank: z.object({
    licenceRef: z.string().trim().min(2, 'record the licence reference').max(80),
    note: z.string().trim().max(500).optional(),
  }),
};

/**
 * Run the clinical claim filter, converting a block into a 400.
 *
 * assertNoClinicalClaim throws a plain Error on purpose, so that it fails loudly
 * wherever it is called, including in a background job with no HTTP in sight.
 * The cost of that is that a route which forwards the throw straight to next()
 * turns a rejected request into a 500, which tells the writer their input was
 * fine and tells an operator the server is broken. Neither is true. Every route
 * that filters user text goes through here.
 */
export function guardClinicalClaim(text) {
  try {
    assertNoClinicalClaim(text);
    return null;
  } catch (err) {
    return errors.badRequest(err.message, { code: 'clinical_claim_blocked' });
  }
}

/**
 * Translate a domain error into an HTTP status.
 *
 * The mapping is explicit and total. Anything unrecognised becomes a generic 500
 * rather than being passed through, so a new error type can never accidentally
 * surface its own message.
 */
export function errorHandler(logger = console) {
  // eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity.
  return (err, req, res, next) => {
    if (err instanceof WeakPasswordError) {
      res.status(422).json(
        errors.badRequest('Choose a longer password, at least 10 characters.').toProblem(),
      );
      return;
    }

    if (err instanceof InsufficientStockError) {
      res.status(409).json(
        errors.conflict(err.message, {
          requested: err.requested,
          available: err.available,
          code: 'insufficient_stock',
        }).toProblem(),
      );
      return;
    }

    if (err instanceof BankNotVerifiedError) {
      // 409, not 403. The bank exists and may hold stock, it is simply not
      // cleared to supply, which is a state to move out of rather than a
      // permission to be refused.
      res.status(409).json(
        errors.conflict('This bank is not verified to supply yet.', {
          code: 'bank_unverified',
        }).toProblem(),
      );
      return;
    }

    if (err instanceof AuthError) {
      const status = err.code === 'throttled' ? 429 : err.code === 'unavailable' ? 409 : 401;
      res.status(status).json(
        new errors.ApiError(status, {
          type: `urn:problem:${err.code}`,
          title: 'Sign in required',
          detail: err.message,
          extra: { code: err.code },
        }).toProblem(),
      );
      return;
    }

    if (err instanceof UnauthenticatedError) {
      res.status(401).json(errors.unauthenticated().toProblem());
      return;
    }

    if (err instanceof ForbiddenError) {
      res.status(403).json(
        errors.forbidden(`Not permitted: ${err.permission} (${err.reason}).`).toProblem(),
      );
      return;
    }

    if (err instanceof errors.ApiError) {
      res.status(err.status).json(err.toProblem());
      return;
    }

    // CORS rejections and other middleware short circuits arrive as plain errors.
    if (err?.code === 'LIMIT_FILE_SIZE' || err?.type === 'entity.too.large') {
      res.status(413).json(errors.badRequest('That request body is too large.').toProblem());
      return;
    }

    // Everything else is ours, not the caller's.
    logger.error?.('[unhandled]', err?.stack ?? String(err), {
      path: req?.path,
      method: req?.method,
    });

    res.status(500).json(errors.serverError().toProblem());
  };
}

/** 404 for anything the router did not claim. */
export function notFoundHandler(req, res) {
  res.status(404).json(errors.notFound(`No route for ${req.method} ${req.path}.`).toProblem());
}
