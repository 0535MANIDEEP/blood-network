import { planFulfilment, planDonorNotifications } from './fulfilment.js';
import { canDonateAgain } from './eligibility.js';

/**
 * COMMUNITY ESCALATION
 * ====================
 *
 * The design decision this encodes: when someone needs blood, institutional supply
 * and the donor community are mobilised AT THE SAME TIME, not one after the other.
 *
 * The original sequencing was banks first, then notify donors only if the banks
 * declined. That is wrong for the end user. At 11pm with a trauma waiting, every
 * minute of a coordinator's inbox round trip is time the patient does not have.
 * Asking the community costs nothing and runs in parallel, so it always runs.
 *
 * A community product also fails in a specific way that a demo does not: people
 * actually act on it. So this module is deliberately conservative about who it
 * contacts and how often.
 *
 *   - Only donors who have opted in to emergency contact are notified. Consent is
 *     checked, not assumed.
 *   - Notification is tiered. The nearest few are asked first, and the next tier
 *     is only widened if the need is still unmet. Nobody gets buried, and message
 *     volume stays survivable for the channels behind it.
 *   - A donor who is also the requesting party is never notified about their own
 *     request.
 *   - Nobody is notified twice for the same request, however many paths they match.
 */

/** Donor notification tiers. Widening is deliberate, never automatic. */
export const DEFAULT_TIERS = Object.freeze([
  Object.freeze({ name: 'nearest', radiusKm: 5, limit: 15 }),
  Object.freeze({ name: 'city', radiusKm: 25, limit: 40 }),
  Object.freeze({ name: 'region', radiusKm: 100, limit: 100 }),
]);

export const URGENCY_MINUTES = Object.freeze({
  emergency: 10,
  urgent: 60,
  routine: 240,
});

/**
 * Build the full escalation plan for one request.
 *
 * @param {object} request  { id, bloodGroup, units, urgency, lat, lon, state, city, raisedBy }
 * @param {object} world
 *   banks:   [{ id, name, lat, lon, verifiedAt, stock }]
 *   donors:  [{ id, bloodGroup, available, lat, lon, consented: { emergency: true } }]
 *   options: { tiers, requireVerified, maxDonorNotifications, now }
 */
export function buildEscalationPlan(request, world = {}) {
  const { banks = [], donors = [], options = {} } = world;
  const {
    tiers = DEFAULT_TIERS,
    requireVerified = true,
    maxDonorNotifications = 40,
    now = new Date(),
  } = options;

  if (!request || typeof request !== 'object') {
    return { ok: false, reason: 'no_request' };
  }

  // ---- Institutional path, built now, not after a decline --------------------
  const institutional = planFulfilment(request, banks, { requireVerified }).map((candidate) => ({
    ...candidate,
    path: 'bank',
    action: 'contact_bank',
  }));

  const bankCoverable = institutional.filter((c) => c.totalUsableUnits >= (request.units ?? 0)).length > 0;

  // ---- Community path, built in parallel ------------------------------------
  // Matching runs against every available donor, then consent decides who is
  // actually contacted. Computing matches from the consented list first would
  // make the unconsented count permanently zero, and with it the ability to show
  // a matching donor an opt-in prompt at the exact moment they would care.
  const available = donors.filter((d) => d && d.available === true);
  const consentedIds = new Set(
    available.filter((d) => d.consented?.emergency === true).map((d) => d.id),
  );

  const allMatches = planDonorNotifications(request, available, { includeUnavailable: false });

  // Consent is a gate on contact, never on eligibility.
  const matches = allMatches.filter((m) => consentedIds.has(m.donor.id));

  // The person who raised it does not need telling.
  const raisedBy = request.raisedBy ?? null;
  const eligible = matches.filter((m) => m.donor.id !== raisedBy);

  // Matching donors who have not opted in. Never contacted. Counted so the app
  // can offer them consent instead of silently ignoring them.
  const unconsentedMatches = allMatches.filter((m) => !consentedIds.has(m.donor.id)).length;

  // Tier them so the community is widened on purpose, not reflexively.
  const stagedTiers = [];
  const alreadyChosen = new Set();
  let cumulative = 0;

  for (const tier of tiers) {
    const picked = [];
    // The cap has to apply within a tier as well as between tiers, otherwise a
    // single wide tier blows straight past the limit and the whole point of
    // tiering is lost.
    const roomInThisTier = Math.max(0, Math.min(tier.limit, maxDonorNotifications - cumulative));
    if (roomInThisTier === 0) break;

    for (const match of eligible) {
      if (picked.length >= roomInThisTier) break;
      if (alreadyChosen.has(match.donor.id)) continue;
      if (match.distanceKm !== null && match.distanceKm > tier.radiusKm) continue;
      alreadyChosen.add(match.donor.id);
      picked.push({
        donorId: match.donor.id,
        bloodGroup: match.donor.bloodGroup,
        distanceKm: match.distanceKm,
        exactGroup: match.exactGroup,
        phone: match.donor.phone,
      });
    }
    cumulative += picked.length;
    stagedTiers.push({
      name: tier.name,
      radiusKm: tier.radiusKm,
      notified: picked,
      // Widen to the next tier only if this one has not answered in time.
      advanceAfterMinutes: URGENCY_MINUTES[request.urgency] ?? URGENCY_MINUTES.routine,
    });
    if (cumulative >= maxDonorNotifications) break;
  }

  // Everyone reachable, in tier order, deduplicated.
  const notificationQueue = stagedTiers.flatMap((t) =>
    t.notified.map((n) => ({ ...n, tier: t.name })),
  );

  return {
    ok: true,
    requestId: request.id ?? null,
    urgency: request.urgency ?? 'routine',
    // Both paths start together. This is the whole point.
    parallel: {
      institutional,
      community: {
        tiers: stagedTiers,
        queue: notificationQueue,
        matchedCount: eligible.length,
        queuedCount: notificationQueue.length,
        consentedCount: consentedIds.size,
        // Donors who match but have not consented. They are not contacted, and
        // the count is surfaced so a consent prompt can be shown to them instead.
        unconsentedMatches,
      },
    },
    banksCanCover: bankCoverable,
    // The honest summary a coordinator needs at a glance.
    summary:
      bankCoverable
        ? `${institutional.length} verified bank(s) can supply. Community notified in parallel: ${notificationQueue.length}.`
        : `No verified bank can supply. Community notified: ${notificationQueue.length} of ${eligible.length} matching donors.`,
  };
}

/**
 * Whether the community tier should widen.
 *
 * Deliberately not automatic. A caller has to decide, because widening spams
 * people, and because a human deciding is the thing that keeps this trustworthy.
 */
export function shouldWidenTier({ plan, elapsedMinutes, stillUnfulfilled }) {
  if (!plan?.ok || !stillUnfulfilled) {
    return { widen: false, reason: stillUnfulfilled ? 'not_yet_due' : 'already_fulfilled' };
  }
  const tiers = plan.parallel?.community?.tiers ?? [];
  const next = tiers.find((t) => t.notified.length === 0);
  if (!next) return { widen: false, reason: 'no_further_tiers' };

  const current = tiers.filter((t) => t.notified.length > 0).at(-1);
  if (!current) return { widen: true, nextTier: next.name, reason: 'first_tier' };

  const due = current.advanceAfterMinutes ?? URGENCY_MINUTES.routine;
  if (elapsedMinutes >= due) {
    return { widen: true, nextTier: next.name, reason: 'tier_unanswered', waitedMinutes: elapsedMinutes };
  }
  return {
    widen: false,
    reason: 'waiting_on_current_tier',
    waitMinutes: due - elapsedMinutes,
  };
}

/**
 * Close the loop. This is the part that makes a community rather than a broadcast
 * list: the donor finds out what happened to their offer.
 *
 * It also gives the project its integrity property, because a notification whose
 * outcome is never reported teaches people not to respond next time.
 */
export function buildOutcomeNotice({ request, donor, outcome, bankName, at = new Date() }) {
  const base = {
    requestId: request?.id ?? null,
    donorId: donor?.id ?? null,
    outcome,
    at: at.toISOString(),
  };

  switch (outcome) {
    case 'fulfilled_by_bank':
      return {
        ...base,
        channel: 'impact',
        subject: 'Your offer was matched to a donor network',
        body:
          `A need for ${request.bloodGroup} at ${request.hospital ?? 'a hospital nearby'} ` +
          `was covered${bankName ? ` by ${bankName}` : ''}. Thank you for being available.`,
        // Never claim the unit was safe. The bank and a clinician decide that.
        clinicalClaim: false,
      };

    case 'fulfilled_by_community':
      return {
        ...base,
        channel: 'impact',
        subject: 'A donation you offered was completed',
        body: `The ${request.bloodGroup} need at ${request.hospital ?? 'a hospital nearby'} was covered by the community.`,
        clinicalClaim: false,
      };

    case 'covered_elsewhere':
      return {
        ...base,
        channel: 'impact',
        subject: 'That need was already covered',
        body: 'Someone closer covered this one before your offer arrived. Thank you for staying ready.',
        clinicalClaim: false,
      };

    case 'expired_unmet':
      return {
        ...base,
        channel: 'honest',
        subject: 'That need is still open',
        body: 'We did not manage to cover this request. It remains open and is still being worked.',
        clinicalClaim: false,
      };

    default:
      return {
        ...base,
        channel: 'impact',
        subject: 'Update on a blood request',
        body: 'There is an update on a request you responded to.',
        clinicalClaim: false,
      };
  }
}

/**
 * Donor re-engagement.
 *
 * Most people donate once and never again, and that single leak is the biggest
 * problem in donor networks by volume. This surfaces the donors who are eligible
 * again today, which is the cheapest retention win available.
 */
export function findReengagementCandidates(donors, now = new Date()) {
  if (!Array.isArray(donors)) return [];
  return donors
    .filter((d) => d && typeof d === 'object')
    .map((d) => {
      const check = canDonateAgain(d, now);
      return { donor: d, ...check };
    })
    .filter((c) => c.allowed)
    .sort((a, b) => {
      // Longest rested first, so nobody is nudged ahead of someone overdue.
      if (a.elapsed === null || b.elapsed === null) return 0;
      return b.elapsed - a.elapsed;
    });
}
