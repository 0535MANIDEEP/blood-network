import { buildMessage, ConsentRequired, NotificationRefused } from './channels.js';
import { canDonate } from '../domain/compatibility.js';
import { requiredDisclaimer } from '../policy/boundary.js';

/**
 * Dispatch.
 *
 * The rule that shapes this whole file: consent is checked at SEND time, not at
 * queue time.
 *
 * A queued notification might sit for minutes while a coordinator works. If
 * consent was only checked when it was queued, a donor who opted out in between
 * still gets messaged, and the thing they were trying to do did not work. Consent
 * is revocable, so the only correct moment to honour it is the moment of sending.
 *
 * Second rule: nothing is ever sent claiming to be a clinical authority. Every
 * outbound message is built through buildMessage, which refuses the words this
 * project is not entitled to use.
 */

/** Why a queued notification was not sent. Each maps to a real status. */
export const SKIP = Object.freeze({
  NO_CONSENT: 'skipped_no_consent',
  SUBJECT_GONE: 'skipped_subject_gone',
  NO_CHANNEL: 'skipped_no_channel',
  DUPLICATE: 'skipped_duplicate',
});

/**
 * Is this subject allowed to be messaged about this purpose, right now?
 *
 * Consent is a revocable record, so "granted = true and never revoked" is the
 * only state that counts. A row that says granted but also carries a revoked_at
 * is a donor who changed their mind, and honouring the stale flag is the exact
 * bug this exists to prevent.
 */
export function checkConsent(consents, { subjectType, subjectId, channel, purpose }) {
  const match = (consents ?? []).find(
    (c) =>
      c.subject_type === subjectType &&
      c.subject_id === subjectId &&
      c.channel === channel &&
      c.purpose === purpose,
  );

  if (!match) return { allowed: false, reason: 'never_consented' };
  if (match.granted !== true) return { allowed: false, reason: 'declined' };
  if (match.revoked_at) return { allowed: false, reason: 'revoked_after_granting' };
  return { allowed: true, reason: 'granted' };
}

/**
 * Turn an escalation plan into the messages to send.
 *
 * The request is passed separately because the plan deliberately does not carry
 * the requester's phone number. The plan is a thing a coordinator screen shows
 * and a public preview summarises, so it holds counts and tiers, and putting a
 * contact number on it would put one number closer to being exposed.
 */
export function buildCommunityMessages({ plan, request, donorsById, channel = 'sms' }) {
  const messages = [];

  for (const tier of plan.parallel?.community?.tiers ?? []) {
    for (const entry of tier.notified) {
      const donor = donorsById.get(entry.donorId);
      if (!donor) continue;

      // A donor who cannot actually serve this group must never be asked. The
      // planner already filters, but this is the last check before a real person's
      // phone, and the cost of being wrong here is a wasted journey at 2am.
      if (!canDonate(donor.bloodGroup, request.bloodGroup)) continue;

      messages.push(
        buildMessage({
          to: donor.phone,
          channel,
          reference: request.id,
          subject: `Blood needed: ${request.bloodGroup}`,
          body:
            `${requiredDisclaimer()}\n\n` +
            `${request.units} unit(s) of ${request.bloodGroup} needed at ${request.hospital ?? 'a hospital nearby'}` +
            `${request.urgency === 'emergency' ? '. This is an emergency.' : '.'}\n` +
            `You are about ${Math.round(entry.distanceKm ?? 0)} km away and your group matches.` +
            `${entry.exactGroup ? ' Exact group match.' : ''}\n\n` +
            `If you can help, contact the family on ${request.contactPhone ?? 'the number in the app'}. ` +
            `Please do not travel if you are unwell.`,
        }),
      );
    }
  }

  return messages;
}

/**
 * Send everything queued.
 *
 * Reads its own queue rather than taking a list, so the consent check inside the
 * loop is unavoidable. A caller cannot hand in pre-filtered notifications and
 * skip the gate, which is the only way to guarantee the gate is never skipped.
 */
export async function dispatchQueued(db, { channel, limit = 100 } = {}) {
  const queued = await db.query(
    `SELECT * FROM notifications WHERE status = 'queued' ORDER BY created_at ASC LIMIT $1`,
    [limit],
  );

  const results = { sent: 0, skipped: 0, failed: 0, dryRun: 0, details: [] };

  for (const row of queued) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;

    // ---- Consent, re-checked now and not trusted from the queue ------------
    let consents = [];
    if (payload.donorId) {
      consents = await db.query(
        `SELECT subject_type, subject_id, channel, purpose, granted, revoked_at
           FROM consents WHERE subject_type = 'donor' AND subject_id = $1`,
        [payload.donorId],
      );

      const verdict = checkConsent(consents, {
        subjectType: 'donor',
        subjectId: payload.donorId,
        channel: payload.channel ?? 'sms',
        purpose: payload.purpose ?? 'emergency_contact',
      });

      if (!verdict.allowed) {
        await db.query('UPDATE notifications SET status = $2 WHERE id = $1', [row.id, SKIP.NO_CONSENT]);
        results.skipped += 1;
        results.details.push({ id: row.id, status: SKIP.NO_CONSENT, reason: verdict.reason });
        continue;
      }
    }

    // ---- Build, which refuses clinical claims ------------------------------
    let message;
    try {
      message = buildMessage({
        to: payload.to ?? row.recipient,
        channel: payload.channel ?? row.channel,
        subject: payload.subject,
        body: payload.body,
        reference: payload.requestId,
      });
    } catch (err) {
      if (err instanceof NotificationRefused) {
        await db.query('UPDATE notifications SET status = $2 WHERE id = $1', [row.id, 'failed']);
        results.failed += 1;
        results.details.push({ id: row.id, status: 'failed', reason: err.reason });
        continue;
      }
      throw err;
    }

    // ---- Send --------------------------------------------------------------
    try {
      const outcome = await channel.send(message);

      // A dry run leaves the row exactly as it was. Consuming the queue would
      // mean that exercising the dispatcher emptied it, and the real dispatch
      // afterwards would have nothing left to send, which is the worst possible
      // time to discover it.
      if (outcome.dryRun) {
        results.dryRun += 1;
        results.details.push({ id: row.id, status: 'queued', reason: 'dry_run' });
      } else if (outcome.delivered) {
        await db.query('UPDATE notifications SET status = $2 WHERE id = $1', [row.id, 'sent']);
        results.sent += 1;
        results.details.push({ id: row.id, status: 'sent' });
      } else {
        await db.query('UPDATE notifications SET status = $2 WHERE id = $1', [row.id, 'failed']);
        results.failed += 1;
        results.details.push({ id: row.id, status: 'failed', reason: outcome.reason });
      }
    } catch (err) {
      if (err instanceof ConsentRequired) {
        await db.query('UPDATE notifications SET status = $2 WHERE id = $1', [row.id, SKIP.NO_CONSENT]);
        results.skipped += 1;
        continue;
      }
      // One bad message must not stop the rest of the queue.
      await db.query('UPDATE notifications SET status = $2 WHERE id = $1', [row.id, 'failed']);
      results.failed += 1;
      results.details.push({ id: row.id, status: 'failed', reason: err.message });
    }
  }

  return results;
}
