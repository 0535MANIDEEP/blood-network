import { Router } from 'express';

import { requireAuth, requireRole, validate, schemas } from '../middleware.js';
import { presentDonor, presentRequestList } from '../present.js';
import { canDonateRedCells } from '../../domain/compatibility.js';
import { canDonateAgain } from '../../domain/eligibility.js';
import { toDonorDomain } from '../../db/donors.js';
import { requiredDisclaimer } from '../../policy/boundary.js';
import { notFound } from '../errors.js';

/**
 * Donor side.
 *
 * The person using this is not a record in a system. They are somebody who
 * donated once, or is thinking about it, or was woken up at 2am. So the two
 * things this file is built around are:
 *
 *   telling them when they can donate again, because the single largest volume
 *   problem in donor networks is people who donate once and never return, and
 *
 *   never contacting them for something they did not agree to.
 */
export function donorRoutes({ db } = {}) {
  const router = Router();

  router.use(requireAuth, requireRole('donor'));

  const loadSelf = async (req) => {
    const rows = await db.query('SELECT * FROM donors WHERE id = $1', [req.user.subjectId]);
    if (rows.length === 0) {
      throw notFound('Your donor record is missing. Contact support.');
    }
    return rows[0];
  };

  router.get('/profile', async (req, res, next) => {
    try {
      const donor = await loadSelf(req);
      const again = canDonateAgain(toDonorDomain(donor));

      res.json({
        donor: presentDonor(donor, { detailed: true }),
        canDonateAgain: again,
        // Said on the response rather than buried in a README, because the most
        // damaging misunderstanding this project could cause is somebody reading
        // "you can donate again" as "you are cleared to donate".
        screening: {
          doneHere: false,
          doneBy: 'A licensed blood bank, in person, at collection.',
          note: 'This project checks the donation INTERVAL only. Haemoglobin, weight, vital signs and medical history are screened at the collection centre by a clinician.',
        },
        disclaimer: requiredDisclaimer(),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Availability and consent are set here, and they are not the same switch.
   *
   * Available means "I could go today". Consent to emergency contact means "you
   * may message me about a need at 2am". A donor can be the first without the
   * second, which is the point: a person who will donate when their neighbour
   * asks in person has not agreed to be interrupted at night, and treating the
   * two as one flag is how a registry becomes a nuisance and loses its donors.
   *
   * Availability is deliberately NOT gated on the clinical screen. It is a
   * statement of willingness, and a willingness flag has no business requiring
   * anybody to certify their own haemoglobin. The interval is surfaced as advice
   * rather than enforced as a rule, because the person who actually decides
   * whether a donation proceeds is the clinician at the collection centre.
   */
  router.patch('/availability', validate(schemas.setAvailability), async (req, res, next) => {
    try {
      const donor = await loadSelf(req);
      const { available, consentEmergency } = req.body;

      // Only the fields actually sent. A PATCH that rewrites availability when
      // the caller only asked to change consent would quietly undo whatever the
      // donor had set in between.
      let updated = donor;
      if (available !== undefined) {
        const rows = await db.query('UPDATE donors SET available = $2 WHERE id = $1 RETURNING *', [
          donor.id,
          available,
        ]);
        updated = rows[0];
      }

      let consent = null;
      if (consentEmergency !== undefined) {
        const rows = await db.query(
          `INSERT INTO consents (subject_type, subject_id, channel, purpose, granted, granted_at, revoked_at)
           VALUES ('donor', $1, 'sms', 'emergency_contact', $2,
                   CASE WHEN $2 THEN now() ELSE NULL END,
                   CASE WHEN $2 THEN NULL ELSE now() END)
           ON CONFLICT (subject_type, subject_id, channel, purpose)
           DO UPDATE SET granted = EXCLUDED.granted,
                         granted_at = EXCLUDED.granted_at,
                         revoked_at = EXCLUDED.revoked_at
         RETURNING granted, granted_at, revoked_at`,
          [donor.id, consentEmergency],
        );
        consent = rows[0];
      }

      res.json({
        donor: presentDonor(updated, { detailed: true }),
        consentEmergency: consent
          ? { granted: consent.granted, grantedAt: consent.granted_at, revokedAt: consent.revoked_at }
          : undefined,
        canDonateAgain: canDonateAgain(toDonorDomain(updated)),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * What is needed near this donor, that they could actually donate.
   *
   * Ordered by the shortfall first, not by recency, because the useful signal is
   * "three banks near me have none of this and two people have asked" rather than
   * a list of requests in whatever order the database returned.
   */
  router.get('/nearby-needs', async (req, res, next) => {
    try {
      const donor = await loadSelf(req);

      const rows = await db.query(
        `SELECT r.*,
                COALESCE(SUM(i.units) FILTER (WHERE i.units > 0), 0) AS nearby_stock
           FROM requests r
           LEFT JOIN banks b ON b.state = r.state AND b.city = r.city AND b.verified_at IS NOT NULL
           LEFT JOIN inventory i ON i.bank_id = b.id AND i.blood_group = r.blood_group
          WHERE r.status = 'open'
            AND (r.state = $1 OR r.state = '')
          GROUP BY r.id
          ORDER BY r.created_at DESC
          LIMIT 50`,
        [donor.state],
      );

      const canServe = rows.filter((r) => canDonateRedCells(donor.blood_group, r.blood_group));

      res.json({
        needs: presentRequestList(canServe, { viewer: req.user, viewerRole: 'donor' }).map((r) => ({
          ...r,
          // How far this request is from actually being covered by a verified
          // bank nearby. A request that no bank can fill is the one worth a
          // phone call, and without this number nobody can tell.
          nearbyStock: Number(r.nearbyStock ?? 0),
          shortfall: Math.max(0, r.units - Number(r.nearbyStock ?? 0)),
        })),
        // Donors who match but have not opted in are the growth edge, and the
        // prompt only makes sense at the moment they would care.
        youCanServe: canServe.length,
        consentReminder:
          'You will only be contacted about a need after you turn on emergency contact.',
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
