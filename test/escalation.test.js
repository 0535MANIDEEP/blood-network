import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEscalationPlan,
  shouldWidenTier,
  buildOutcomeNotice,
  findReengagementCandidates,
} from '../src/domain/escalation.js';

const BANJARA = [17.4126, 78.4347];
const GACHIBOWLI = [17.4401, 78.3489];
const SECUNDERABAD = [17.3899, 78.4983];
const VJNT = [17.4549, 78.5875]; // roughly 15 km east of Banjara Hills

const bank = (id, lat, lon, stock) => ({
  id,
  name: `Bank ${id}`,
  lat,
  lon,
  verifiedAt: '2026-01-01T00:00:00Z',
  stock,
});

const donor = (id, bloodGroup, lat, lon, over = {}) => ({
  id,
  name: `Donor ${id}`,
  phone: `90000000${id.slice(-1)}`,
  bloodGroup,
  available: true,
  lat,
  lon,
  consented: { emergency: true },
  ...over,
});

const emergency = (over = {}) => ({
  id: 'req-1',
  bloodGroup: 'O-',
  units: 2,
  urgency: 'emergency',
  hospital: 'Apollo Hospital, Jubilee Hills',
  lat: BANJARA[0],
  lon: BANJARA[1],
  ...over,
});

describe('parallel mobilisation', () => {
  test('banks and the community are mobilised in the same plan, not in sequence', () => {
    const plan = buildEscalationPlan(emergency(), {
      banks: [bank('b1', SECUNDERABAD[0], SECUNDERABAD[1], { 'O-': 5 })],
      donors: [donor('d1', 'O-', GACHIBOWLI[0], GACHIBOWLI[1])],
    });

    assert.equal(plan.ok, true);
    assert.ok(plan.parallel.institutional.length > 0, 'bank path is built');
    assert.ok(plan.parallel.community.queuedCount > 0, 'community path is built at the same time');
  });

  test('the community is notified even when a bank can cover the need', () => {
    // Waiting for a bank to decline first would add a full round trip at 11pm.
    const plan = buildEscalationPlan(emergency(), {
      banks: [bank('b1', SECUNDERABAD[0], SECUNDERABAD[1], { 'O-': 5 })],
      donors: [donor('d1', 'O-', GACHIBOWLI[0], GACHIBOWLI[1])],
    });
    assert.equal(plan.banksCanCover, true);
    assert.ok(plan.parallel.community.queuedCount > 0, 'community still runs in parallel');
    assert.match(plan.summary, /in parallel/i);
  });

  test('a summary states plainly when no bank can supply', () => {
    const plan = buildEscalationPlan(emergency(), {
      banks: [bank('b1', SECUNDERABAD[0], SECUNDERABAD[1], { 'A+': 5 })],
      donors: [donor('d1', 'O-', GACHIBOWLI[0], GACHIBOWLI[1])],
    });
    assert.equal(plan.banksCanCover, false);
    assert.match(plan.summary, /No verified bank can supply/);
  });
});

describe('consent is a gate, not a preference', () => {
  test('a matching donor who has not consented is not contacted', () => {
    const plan = buildEscalationPlan(emergency(), {
      donors: [donor('d1', 'O-', GACHIBOWLI[0], GACHIBOWLI[1], { consented: {} })],
    });
    assert.equal(plan.parallel.community.queuedCount, 0);
  });

  test('consent explicitly refused is not contacted', () => {
    const plan = buildEscalationPlan(emergency(), {
      donors: [donor('d1', 'O-', GACHIBOWLI[0], GACHIBOWLI[1], { consented: { emergency: false } })],
    });
    assert.equal(plan.parallel.community.queuedCount, 0);
  });

  test('unconsented matches are counted so the app can ask them to opt in', () => {
    const plan = buildEscalationPlan(emergency(), {
      donors: [
        donor('d1', 'O-', GACHIBOWLI[0], GACHIBOWLI[1]),
        donor('d2', 'O-', VJNT[0], VJNT[1], { consented: {} }),
      ],
    });
    assert.equal(plan.parallel.community.queuedCount, 1);
    assert.equal(plan.parallel.community.unconsentedMatches, 1);
  });

  test('unavailable donors are not contacted', () => {
    const plan = buildEscalationPlan(emergency(), {
      donors: [donor('d1', 'O-', GACHIBOWLI[0], GACHIBOWLI[1], { available: false })],
    });
    assert.equal(plan.parallel.community.queuedCount, 0);
  });
});

describe('notification is tiered, not a blast', () => {
  const many = [
    donor('near1', 'O-', GACHIBOWLI[0], GACHIBOWLI[1]),
    donor('near2', 'O-', BANJARA[0], BANJARA[1]),
    donor('mid1', 'O-', VJNT[0], VJNT[1]),
    donor('mid2', 'O-', SECUNDERABAD[0], SECUNDERABAD[1]),
  ];

  test('the first tier is limited so nobody is buried', () => {
    const plan = buildEscalationPlan(emergency({ units: 1 }), {
      donors: many,
      options: { tiers: [{ name: 'nearest', radiusKm: 5, limit: 1 }] },
    });
    assert.equal(plan.parallel.community.tiers[0].notified.length, 1);
  });

  test('donors far outside the first radius are not in the first tier', () => {
    const plan = buildEscalationPlan(emergency({ units: 1 }), {
      donors: [donor('far1', 'O-', VJNT[0], VJNT[1])],
      options: { tiers: [{ name: 'nearest', radiusKm: 1, limit: 50 }] },
    });
    assert.equal(plan.parallel.community.tiers[0].notified.length, 0);
  });

  test('no donor appears in more than one tier', () => {
    const plan = buildEscalationPlan(emergency({ units: 1 }), {
      donors: many,
      options: {
        tiers: [
          { name: 'nearest', radiusKm: 50, limit: 2 },
          { name: 'city', radiusKm: 50, limit: 10 },
        ],
      },
    });
    const ids = plan.parallel.community.tiers.flatMap((t) => t.notified.map((n) => n.donorId));
    assert.equal(new Set(ids).size, ids.length, 'no duplicates across tiers');
  });

  test('the overall notification cap is respected', () => {
    const crowd = Array.from({ length: 40 }, (_, i) =>
      donor(`d${i}`, 'O-', BANJARA[0] + i * 0.001, BANJARA[1]),
    );
    const plan = buildEscalationPlan(emergency({ units: 1 }), {
      donors: crowd,
      options: { maxDonorNotifications: 10 },
    });
    assert.ok(plan.parallel.community.queuedCount <= 10);
  });

  test('nobody is notified about their own request', () => {
    const plan = buildEscalationPlan(emergency({ raisedBy: 'd1' }), {
      donors: [donor('d1', 'O-', GACHIBOWLI[0], GACHIBOWLI[1]), donor('d2', 'O-', BANJARA[0], BANJARA[1])],
    });
    const ids = plan.parallel.community.queue.map((n) => n.donorId);
    assert.ok(!ids.includes('d1'));
    assert.ok(ids.includes('d2'));
  });

  test('incompatible donors are never queued', () => {
    // O negative is the most restricted RECIPIENT in red cell terms. Group O is
    // the universal donor, not the universal recipient, so B negative cannot
    // serve an O negative patient. Only O negative can.
    const plan = buildEscalationPlan(emergency(), {
      donors: [
        donor('a', 'A+', GACHIBOWLI[0], GACHIBOWLI[1]),
        donor('b', 'B-', GACHIBOWLI[0], GACHIBOWLI[1]),
        donor('c', 'O-', GACHIBOWLI[0], GACHIBOWLI[1]),
      ],
    });
    const ids = plan.parallel.community.queue.map((n) => n.donorId);
    assert.deepEqual(ids, ['c'], 'only O- can serve an O- recipient');
  });
});

describe('widening a tier is deliberate', () => {
  const plan = buildEscalationPlan(emergency({ units: 1 }), {
    donors: [donor('near1', 'O-', GACHIBOWLI[0], GACHIBOWLI[1]), donor('far1', 'O-', VJNT[0], VJNT[1])],
    options: {
      tiers: [
        { name: 'nearest', radiusKm: 5, limit: 5 },
        { name: 'city', radiusKm: 30, limit: 5 },
      ],
    },
  });

  test('no widening while the need is met', () => {
    const r = shouldWidenTier({ plan, elapsedMinutes: 999, stillUnfulfilled: false });
    assert.equal(r.widen, false);
    assert.equal(r.reason, 'already_fulfilled');
  });

  test('an emergency widens after the short wait, not before', () => {
    const early = shouldWidenTier({ plan, elapsedMinutes: 2, stillUnfulfilled: true });
    assert.equal(early.widen, false);
    assert.ok(early.waitMinutes > 0);

    const later = shouldWidenTier({ plan, elapsedMinutes: 30, stillUnfulfilled: true });
    assert.equal(later.widen, true);
    assert.equal(later.reason, 'tier_unanswered');
  });

  test('a routine need waits far longer before widening', () => {
    const routine = buildEscalationPlan(emergency({ urgency: 'routine', units: 1 }), {
      donors: [donor('near1', 'O-', GACHIBOWLI[0], GACHIBOWLI[1]), donor('far1', 'O-', VJNT[0], VJNT[1])],
      options: {
        tiers: [
          { name: 'nearest', radiusKm: 5, limit: 5 },
          { name: 'city', radiusKm: 30, limit: 5 },
        ],
      },
    });
    const at30 = shouldWidenTier({ plan: routine, elapsedMinutes: 30, stillUnfulfilled: true });
    assert.equal(at30.widen, false, 'routine still waiting at 30 minutes');
  });

  test('no widening is offered once every tier is used', () => {
    const single = buildEscalationPlan(emergency({ units: 1 }), {
      donors: [donor('near1', 'O-', GACHIBOWLI[0], GACHIBOWLI[1])],
      options: { tiers: [{ name: 'nearest', radiusKm: 50, limit: 5 }] },
    });
    const r = shouldWidenTier({ plan: single, elapsedMinutes: 500, stillUnfulfilled: true });
    assert.equal(r.widen, false);
  });
});

describe('closing the loop with the donor', () => {
  const request = { id: 'r1', bloodGroup: 'O-', hospital: 'Apollo Hospital' };

  test('a community fulfilled request reports back without claiming the unit was safe', () => {
    const notice = buildOutcomeNotice({ request, donor: { id: 'd1' }, outcome: 'fulfilled_by_community' });
    assert.equal(notice.clinicalClaim, false);
    assert.doesNotMatch(notice.body, /safe|sterile|approved/i);
  });

  test('covering elsewhere is acknowledged honestly rather than ignored', () => {
    const notice = buildOutcomeNotice({ request, donor: { id: 'd1' }, outcome: 'covered_elsewhere' });
    assert.equal(notice.channel, 'impact');
    assert.match(notice.body, /someone closer covered/i);
    assert.match(notice.body, /thank you/i, 'the donor is still thanked for being ready');
  });

  test('an unmet request says so', () => {
    const notice = buildOutcomeNotice({ request, donor: { id: 'd1' }, outcome: 'expired_unmet' });
    assert.equal(notice.channel, 'honest');
    assert.match(notice.body, /did not manage to cover/i);
    assert.match(notice.body, /remains open/i);
  });

  test('no outcome ever carries a clinical claim', () => {
    for (const outcome of ['fulfilled_by_bank', 'fulfilled_by_community', 'covered_elsewhere', 'expired_unmet', 'unknown']) {
      const notice = buildOutcomeNotice({ request, donor: { id: 'd1' }, outcome });
      assert.equal(notice.clinicalClaim, false, outcome);
    }
  });
});

describe('donor re-engagement', () => {
  const NOW = new Date('2026-09-27T00:00:00Z');

  test('donors whose interval has elapsed are surfaced', () => {
    const ready = findReengagementCandidates(
      [
        { id: 'ready', sex: 'male', previousDonorSex: 'male', isFirstDonation: false, lastDonationDate: '2026-03-01' },
        { id: 'notYet', sex: 'male', previousDonorSex: 'male', isFirstDonation: false, lastDonationDate: '2026-09-01' },
      ],
      NOW,
    );
    assert.deepEqual(ready.map((c) => c.donor.id), ['ready']);
  });

  test('a first time donor has no interval to satisfy', () => {
    const ready = findReengagementCandidates([{ id: 'new', isFirstDonation: true }], NOW);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].elapsed, null);
  });

  test('an unknown previous donation date is not treated as eligible', () => {
    const ready = findReengagementCandidates(
      [{ id: 'unknown', sex: 'male', isFirstDonation: false, lastDonationDate: null }],
      NOW,
    );
    assert.equal(ready.length, 0);
  });

  test('the longest rested donor is nudged first', () => {
    const ready = findReengagementCandidates(
      [
        { id: 'recent', sex: 'male', previousDonorSex: 'male', isFirstDonation: false, lastDonationDate: '2026-05-01' },
        { id: 'longAgo', sex: 'male', previousDonorSex: 'male', isFirstDonation: false, lastDonationDate: '2025-09-01' },
      ],
      NOW,
    );
    assert.equal(ready[0].donor.id, 'longAgo');
  });

  test('malformed input does not throw', () => {
    assert.deepEqual(findReengagementCandidates(null, NOW), []);
    assert.deepEqual(findReengagementCandidates([null, 3], NOW), []);
  });
});

describe('malformed requests', () => {
  test('a missing request is refused rather than producing a plan', () => {
    assert.equal(buildEscalationPlan(null, {}).ok, false);
    assert.equal(buildEscalationPlan(undefined, {}).ok, false);
  });

  test('missing world data yields an empty community path, not a throw', () => {
    const plan = buildEscalationPlan(emergency(), {});
    assert.equal(plan.ok, true);
    assert.equal(plan.parallel.community.queuedCount, 0);
  });
});
