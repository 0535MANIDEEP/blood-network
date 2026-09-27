import { Router } from 'express';

import { requireAuth, requireRole, validate, validateParams, schemas } from '../middleware.js';
import { presentRequestList, presentBank, presentDonor } from '../present.js';
import { buildEscalationPlan, shouldWidenTier, buildOutcomeNotice, findReengagementCandidates } from '../../domain/escalation.js';
import { toRequestDomain, toDonorPlanShape, toBankPlanShape } from '../../db/requests.js';
import { toDonorDomains } from '../../db/donors.js';
import { assertNoClinicalClaim, requiredDisclaimer, BOUNDARY_STATEMENT } from '../../policy/boundary.js';
import { notFound, badRequest } from '../errors.js';

/**
 * Coordinator side.
 *
 * The person who does the work that no automation should do alone: verifying a
 * bank licence, deciding to widen a notification tier, telling a donor their
 * offer did not go through. Every one of those has a person in it on purpose.
 */
export function coordinatorRoutes({ db, notifier } = {}) {
  const router = Router();

  router.use(requireAuth, requireRole('coordinator'));

  router.get('/overview', async (req, res, next) => {
    try {
      const open = await db.query(
        `SELECT blood_group, count(*)::int c FROM requests WHERE status = 'open' GROUP BY blood_group`,
      );
      const banks = await db.query('SELECT verified_at FROM banks');
      const consented = await db.query(
        `SELECT count(*)::int c FROM consents
          WHERE subject_type = 'donor' AND purpose = 'emergency_contact' AND granted = true`,
      );
      const available = await db.query('SELECT count(*)::int c FROM donors WHERE available = true');

      res.json({
        openRequests: open.map((r) => ({ bloodGroup: r.blood_group, count: Number(r.c) })),
        banks: {
          total: banks.length,
          verified: banks.filter((b) => b.verified_at).length,
          awaiting: banks.filter((b) => !b.verified_at).length,
        },
        community: {
          availableNow: Number(available[0].c),
          // The number that actually predicts whether a broadcast reaches anybody.
          // A big donor list where nobody has opted in is a list that cannot be
          // used, and it is worth seeing as a single figure.
          consentedToEmergency: Number(consented[0].c),
        },
        disclaimer: requiredDisclaimer(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/requests', async (req, res, next) => {
    try {
      const rows = await db.query(
        `SELECT * FROM requests
          WHERE status IN ('open','matched')
          ORDER BY
            CASE urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
            created_at ASC
          LIMIT 200`,
      );
      // A coordinator sees contact details, because they are the ones making the
      // phone calls. Same data, different decision, so a different projection.
      res.json({ requests: presentRequestList(rows, { viewer: req.user, viewerRole: 'coordinator' }) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * The full plan for a request, naming donors.
   *
   * Coordinator only, and the reason is concrete rather than bureaucratic: the
   * queue contains names and phone numbers of people who said they would
   * donate. Exposing that on a public GET would turn a consent-gated list into
   * a directory, and consent would stop meaning anything.
   */
  router.post('/requests/:id/escalate', validateParams(schemas.requestId), async (req, res, next) => {
    try {
      const request = await db.query('SELECT * FROM requests WHERE id = $1', [req.params.id]);
      if (request.length === 0) {
        next(notFound('No such request.'));
        return;
      }

      const banks = await db.query('SELECT id, name, lat, lon, verified_at FROM banks WHERE verified_at IS NOT NULL');
      const inventory = await db.query('SELECT bank_id, blood_group, units FROM inventory WHERE units > 0');
      const donors = await db.query('SELECT id, name, phone, blood_group, available, lat, lon FROM donors');
      const consents = await db.query(
        `SELECT subject_id, granted FROM consents
          WHERE subject_type = 'donor' AND channel = 'sms' AND purpose = 'emergency_contact'`,
      );
      const consentByDonor = new Map(consents.map((c) => [c.subject_id, c.granted]));

      const stockByBank = new Map();
      for (const row of inventory) {
        if (!stockByBank.has(row.bank_id)) stockByBank.set(row.bank_id, {});
        stockByBank.get(row.bank_id)[row.blood_group] = Number(row.units);
      }

      const plan = buildEscalationPlan(toRequestDomain(request[0]), {
        banks: banks.map((b) => toBankPlanShape(b, stockByBank.get(b.id) ?? {})),
        donors: donors.map((d) =>
          toDonorPlanShape(d, { consentedEmergency: consentByDonor.get(d.id) === true }),
        ),
      });

      res.json({
        requestId: request[0].id,
        summary: plan.summary,
        banksCanCover: plan.banksCanCover,
        institutional: plan.parallel.institutional.map((c) => ({
          bankId: c.bank.id,
          bankName: c.bank.name,
          distanceKm: c.distanceKm === null ? null : Number(c.distanceKm.toFixed(1)),
          unitsAvailable: c.usableUnits,
        })),
        community: {
          tiers: plan.parallel.community.tiers.map((t) => ({
            name: t.name,
            radiusKm: t.radiusKm,
            widenAfterMinutes: t.advanceAfterMinutes,
            donors: t.notified,
          })),
          queued: plan.parallel.community.queuedCount,
          // The prompt list. These people match and would help, and have not said
          // yes to being messaged. Shown so a coordinator can ask, never queued.
          unconsentedMatches: plan.parallel.community.unconsentedMatches,
        },
        disclaimer: BOUNDARY_STATEMENT,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Should the community be widened?
   *
   * Returns a recommendation, never performs the widening. Sending messages to
   * more people is the kind of action that should need a deliberate human, and a
   * cron job that quietly doubles the blast radius overnight is exactly how a
   * donor community gets switched off by the people it depends on.
   */
  router.post('/requests/:id/widen-check', validateParams(schemas.requestId), async (req, res, next) => {
    try {
      const request = await db.query('SELECT * FROM requests WHERE id = $1', [req.params.id]);
      if (request.length === 0) {
        next(notFound('No such request.'));
        return;
      }

      const elapsed = Math.floor(
        (Date.now() - new Date(request[0].created_at).getTime()) / 60_000,
      );
      const stillOpen = request[0].status === 'open';

      // Rebuild the plan so the tier state is current, then ask.
      const preview = buildEscalationPlan(toRequestDomain(request[0]), { banks: [], donors: [] });
      const decision = shouldWidenTier({
        plan: { ...preview, ok: true },
        elapsedMinutes: elapsed,
        stillUnfulfilled: stillOpen,
      });

      res.json({
        elapsedMinutes: elapsed,
        stillUnfulfilled: stillOpen,
        recommendation: decision,
        // Named as a recommendation so nobody skims this endpoint and treats the
        // boolean as an action that has been taken.
        actionTaken: false,
        note: 'Widening is a human decision. This endpoint only advises.',
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Verify a bank.
   *
   * Records a licence reference that a human looked up. It does not confirm the
   * licence with the regulator, because this project has no way to do that and
   * pretending otherwise would make the field a lie. The wording is chosen to be
   * true: recorded, not verified with the authority.
   */
  router.post('/banks/:id/verify', validateParams(schemas.bankId), validate(schemas.verifyBank), async (req, res, next) => {
    try {
      const existing = await db.query('SELECT id, verified_at FROM banks WHERE id = $1', [req.params.id]);
      if (existing.length === 0) {
        next(notFound('No such bank.'));
        return;
      }

      const rows = await db.query(
        `UPDATE banks SET licence_ref = $2, verified_at = now() WHERE id = $1 RETURNING *`,
        [req.params.id, req.body.licenceRef],
      );

      res.json({
        bank: presentBank(rows[0], { detailed: true }),
        // Said outright, because this is the field a bank will point at if
        // anything ever goes wrong downstream.
        verificationMeaning:
          'A coordinator recorded this licence reference. It was not confirmed with the State Drug Controller.',
        verifiedBy: { id: req.user.id, name: req.user.displayName },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/banks', async (req, res, next) => {
    try {
      const rows = await db.query('SELECT * FROM banks ORDER BY verified_at NULLS FIRST, name');
      res.json({ banks: rows.map((b) => presentBank(b, { detailed: true })) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Tell a donor what happened to their offer.
   *
   * The part that makes this a community rather than a mailing list. An offer
   * that disappears teaches people not to answer next time, and one notification
   * per request is not spam, it is the deal.
   */
  router.post('/requests/:id/outcome', validateParams(schemas.requestId), async (req, res, next) => {
    try {
      const request = await db.query('SELECT * FROM requests WHERE id = $1', [req.params.id]);
      if (request.length === 0) {
        next(notFound('No such request.'));
        return;
      }

      const outcome = String(req.body?.outcome ?? '');
      const allowed = ['fulfilled_by_bank', 'fulfilled_by_community', 'covered_elsewhere', 'expired_unmet'];
      if (!allowed.includes(outcome)) {
        next(
          badRequest('Unknown outcome.', {
            code: 'bad_outcome',
            allowed,
          }),
        );
        return;
      }

      const donorId = req.body?.donorId ?? null;
      if (donorId) {
        const consent = await db.query(
          `SELECT granted FROM consents
            WHERE subject_type = 'donor' AND subject_id = $1
              AND channel = 'sms' AND purpose = 'emergency_contact'`,
          [donorId],
        );
        // The notice goes out on the same consent that authorised the original
        // contact. Revoking consent stops the follow up too, not just the first
        // message, which is what revoking it is supposed to mean.
        if (consent.length === 0 || consent[0].granted !== true) {
          next(
            badRequest('That donor has not consented to be contacted.', {
              code: 'no_consent',
            }),
          );
          return;
        }
      }

      const notice = buildOutcomeNotice({
        request: request[0],
        donor: { id: donorId },
        outcome,
        bankName: req.body?.bankName,
      });

      // Queued, not sent. No channel is wired up in this build, and the boundary
      // module refuses real recipients, so nothing leaves the database.
      await db.query(
        `INSERT INTO notifications (channel, recipient, template, payload, status)
         VALUES ('sms', $1, 'request_outcome', $2, 'queued')`,
        [donorId ?? 'unknown', JSON.stringify(notice)],
      );

      res.json({
        queued: true,
        // Restated so a coordinator can see the wording that will reach a donor.
        notice,
        disclaimer: requiredDisclaimer(),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Donors whose interval has elapsed, longest rested first.
   *
   * Ids and days only. This is an operational list of people who are overdue for
   * a donation, and it has no reason to carry names on a GET.
   */
  router.get('/reengagement', async (req, res, next) => {
    try {
      const donors = await db.query('SELECT * FROM donors');
      const candidates = findReengagementCandidates(toDonorDomains(donors));

      res.json({
        count: candidates.length,
        candidates: candidates.map((c) => ({
          id: c.donor.id,
          bloodGroup: c.donor.blood_group,
          city: c.donor.city,
          state: c.donor.state,
          daysSinceLastDonation: c.elapsed === null ? null : Math.floor(c.elapsed),
        })),
        note: 'Longest rested first, so nobody is nudged ahead of someone more overdue.',
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/donors', async (req, res, next) => {
    try {
      const rows = await db.query('SELECT * FROM donors ORDER BY created_at DESC LIMIT 200');
      res.json({ donors: rows.map((d) => presentDonor(d, { detailed: true })) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
