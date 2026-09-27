import { Router } from 'express';

import { validate, validateParams, schemas, requireAuth, guardClinicalClaim } from '../middleware.js';
import { presentRequest, presentRequestList } from '../present.js';
import { buildEscalationPlan } from '../../domain/escalation.js';
import { toRequestDomain, toDonorPlanShape, toBankPlanShape } from '../../db/requests.js';
import { requiredDisclaimer } from '../../policy/boundary.js';
import { badRequest, notFound } from '../errors.js';

/**
 * Requests.
 *
 * Raising one is public on purpose. The alternative, requiring an account, means
 * the account creation screen sits between a family at 11pm and the phone call
 * that saves time, and password hashing is slow enough to be felt. So the write
 * path is unauthenticated, rate limited in middleware, and validated here.
 *
 * Everything that touches somebody else's data is not public. The list endpoint
 * never returns a contact number, and the requester is not told who else is
 * looking.
 */
export function requestRoutes({ db, rateLimiter } = {}) {
  const router = Router();

  const viewerOf = (req) => ({ viewer: req.user ?? null, viewerRole: req.user?.role ?? null });

  router.post('/', rateLimiter, validate(schemas.raiseRequest), async (req, res, next) => {
    try {
      const body = req.body;

      // A free text field that reaches a stranger's screen mid emergency.
      const claimError = guardClinicalClaim(body.hospital);
      if (claimError) {
        next(claimError);
        return;
      }

      // A signed in donor's request is attributed to them, so they can follow it.
      // An anonymous one is not, and there is no way to claim it later.
      const createdBy = req.user?.role === 'donor' ? req.user.subjectId : null;

      const rows = await db.query(
        `INSERT INTO requests
           (blood_group, units, urgency, hospital, city, state, lat, lon, contact_phone, needed_by, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          body.bloodGroup,
          body.units,
          body.urgency,
          body.hospital,
          body.city,
          body.state,
          body.lat ?? null,
          body.lon ?? null,
          body.contactPhone,
          body.neededBy ?? null,
          createdBy,
        ],
      );

      const request = createdBy
        ? presentRequest(rows[0], { viewer: req.user, viewerRole: req.user.role })
        : presentRequest(rows[0], { viewer: null, viewerRole: null });

      res.status(201).json({
        request: {
          ...request,
          // The anonymous raiser gets their own number back, and only theirs.
          contactPhone: body.contactPhone,
        },
        disclaimer: requiredDisclaimer(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/', validateParams(schemas.listRequests), async (req, res, next) => {
    try {
      const { bloodGroup, state, city, limit } = req.query;
      const params = [];
      const where = [`status IN ('open','matched')`];

      if (bloodGroup) {
        params.push(bloodGroup);
        where.push(`blood_group = $${params.length}`);
      }
      if (state) {
        params.push(state);
        where.push(`state = $${params.length}`);
      }
      if (city) {
        params.push(city);
        where.push(`city = $${params.length}`);
      }

      params.push(limit);
      const rows = await db.query(
        `SELECT * FROM requests WHERE ${where.join(' AND ')}
          ORDER BY
            CASE urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
            created_at DESC
          LIMIT $${params.length}`,
        params,
      );

      res.json({ requests: presentRequestList(rows, viewerOf(req)), count: rows.length });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', validateParams(schemas.requestId), async (req, res, next) => {
    try {
      const rows = await db.query('SELECT * FROM requests WHERE id = $1', [req.params.id]);
      if (rows.length === 0) {
        next(notFound('No such request.'));
        return;
      }
      res.json({ request: presentRequest(rows[0], viewerOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/replies', requireAuth, validateParams(schemas.requestId), validate(schemas.reply), async (req, res, next) => {
    try {
      const exists = await db.query('SELECT id FROM requests WHERE id = $1', [req.params.id]);
      if (exists.length === 0) {
        next(notFound('No such request.'));
        return;
      }

      const claimError = guardClinicalClaim(req.body.body);
      if (claimError) {
        next(claimError);
        return;
      }

      const rows = await db.query(
        `INSERT INTO request_replies (request_id, author_role, author_id, body)
         VALUES ($1, $2, $3, $4)
         RETURNING id, author_role, body, created_at`,
        [req.params.id, req.user.role, req.user.id, req.body.body],
      );

      res.status(201).json({
        reply: {
          id: rows[0].id,
          // The role, not the identity. "a bank replied" is what matters for
          // trust; "Ravi from bank 3 replied" does not need to be public.
          authorRole: rows[0].author_role,
          body: rows[0].body,
          createdAt: rows[0].created_at,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/replies', validateParams(schemas.requestId), async (req, res, next) => {
    try {
      const exists = await db.query('SELECT id FROM requests WHERE id = $1', [req.params.id]);
      if (exists.length === 0) {
        next(notFound('No such request.'));
        return;
      }

      const rows = await db.query(
        `SELECT id, author_role, body, created_at
           FROM request_replies WHERE request_id = $1 ORDER BY created_at ASC`,
        [req.params.id],
      );

      res.json({
        replies: rows.map((r) => ({
          id: r.id,
          authorRole: r.author_role,
          body: r.body,
          createdAt: r.created_at,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * A preview of the escalation plan, for a request anyone can see.
   *
   * Counts and tier names only. The plan itself names donors and their phone
   * numbers, and putting that behind a public GET would be a phone number
   * directory for anybody who asks nicely. The coordinator endpoint returns the
   * full thing.
   */
  router.get('/:id/escalation-preview', validateParams(schemas.requestId), async (req, res, next) => {
    try {
      const rows = await db.query('SELECT * FROM requests WHERE id = $1', [req.params.id]);
      if (rows.length === 0) {
        next(notFound('No such request.'));
        return;
      }

      const banks = await db.query('SELECT id, name, lat, lon, verified_at FROM banks WHERE verified_at IS NOT NULL');
      const donors = await db.query(
        `SELECT id, blood_group, available, lat, lon FROM donors
          WHERE available = true`,
      );

      const plan = buildEscalationPlan(toRequestDomain(rows[0]), {
        banks: banks.map((b) => toBankPlanShape(b, {})),
        donors: donors.map((d) =>
          // Preview callers are not consented to, so nobody is queued. The counts
          // below are what a community sees, and the queue is what a coordinator
          // acts on.
          toDonorPlanShape(d, { consentedEmergency: false }),
        ),
      });

      res.json({
        preview: {
          banksConsidered: plan.parallel?.institutional?.length ?? 0,
          banksThatCanCover: plan.banksCanCover,
          communityTiers: (plan.parallel?.community?.tiers ?? []).map((t) => ({
            name: t.name,
            radiusKm: t.radiusKm,
            // How many would be asked at this tier, with no identities.
            wouldNotify: t.notified.length,
            widenAfterMinutes: t.advanceAfterMinutes,
          })),
        },
        notice: 'A full plan names individual donors and is only available to a coordinator.',
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
