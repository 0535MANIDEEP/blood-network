import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planFulfilment, planDonorNotifications, distanceKm } from '../src/domain/fulfilment.js';

const bank = (id, lat, lon, stock, extra = {}) => ({
  id,
  name: `Bank ${id}`,
  lat,
  lon,
  verifiedAt: '2026-01-01T00:00:00Z',
  stock,
  ...extra,
});

// Hyderabad coordinates used across the fixtures.
const BANJARA = [17.4126, 78.4347];
const GACHIBOWLI = [17.4401, 78.3489];
const SECUNDERABAD = [17.3899, 78.4983];
const KUKATPALLY = [17.4149, 78.52];

describe('distanceKm', () => {
  test('is zero for the same point', () => {
    assert.equal(distanceKm(17.4, 78.4, 17.4, 78.4), 0);
  });

  test('matches a known Hyderabad distance', () => {
    const km = distanceKm(BANJARA[0], BANJARA[1], GACHIBOWLI[0], GACHIBOWLI[1]);
    assert.ok(km > 7 && km < 11, `expected roughly 9 km, got ${km}`);
  });

  test('returns null when any coordinate is missing', () => {
    assert.equal(distanceKm(null, 78.4, 17.4, 78.4), null);
    assert.equal(distanceKm(17.4, 78.4, undefined, 78.4), null);
  });
});

describe('planFulfilment', () => {
  const banks = [
    bank('near-universal', GACHIBOWLI[0], GACHIBOWLI[1], { 'O-': 5 }),
    bank('exact', BANJARA[0], BANJARA[1], { 'O+': 4 }),
    bank('far', KUKATPALLY[0], KUKATPALLY[1], { 'O+': 9 }),
  ];

  test('a bank is excluded when it cannot serve the group at all', () => {
    const plan = planFulfilment({ bloodGroup: 'O+', units: 1 }, [
      bank('wrong', BANJARA[0], BANJARA[1], { 'A-': 5 }),
    ]);
    assert.equal(plan.length, 0);
  });

  test('a bank is excluded when it holds the right group but too few units', () => {
    const plan = planFulfilment({ bloodGroup: 'O+', units: 3 }, [
      bank('short', BANJARA[0], BANJARA[1], { 'O+': 2 }),
    ]);
    assert.equal(plan.length, 0);
  });

  test('an exact group match outranks a nearer universal donor', () => {
    // Origin Banjara Hills. The O- bank at Gachibowli is about 9.6 km away and
    // the Kukatpally O+ bank about 11.4 km, so the universal donor is nearer than
    // one of the exact matches. Both exact-group banks must still outrank it,
    // because holding the exact group is the better match.
    const plan = planFulfilment(
      { bloodGroup: 'O+', units: 1, lat: BANJARA[0], lon: BANJARA[1] },
      banks,
    );
    assert.equal(plan[0].bankId, 'exact', 'the bank holding the exact group at zero distance wins');
    assert.equal(plan[0].exactGroup, true);
    assert.equal(
      plan[plan.length - 1].bankId,
      'near-universal',
      'a compatible but non exact group ranks last regardless of distance',
    );
  });

  test('with no request location, ties break toward the bank holding more stock', () => {
    const plan = planFulfilment({ bloodGroup: 'O+', units: 1 }, banks);
    assert.equal(plan[0].bankId, 'far', 'far holds 9 units against exact holding 4');
  });

  test('nearer wins when neither is an exact match', () => {
    const plan = planFulfilment(
      { bloodGroup: 'O+', units: 1, lat: GACHIBOWLI[0], lon: GACHIBOWLI[1] },
      [
        bank('a', BANJARA[0], BANJARA[1], { 'O-': 3 }),
        bank('b', SECUNDERABAD[0], SECUNDERABAD[1], { 'O-': 3 }),
      ],
    );
    const [first, second] = plan;
    assert.ok(
      first.distanceKm < second.distanceKm,
      `nearest bank should be first, got ${first.distanceKm} then ${second.distanceKm}`,
    );
    assert.equal(first.bankId, 'a', 'Banjara Hills is closer to Gachibowli than Secunderabad is');
  });

  test('an unverified bank is excluded by default', () => {
    const unverified = bank('unverified', BANJARA[0], BANJARA[1], { 'O+': 5 }, {
      verifiedAt: null,
    });
    assert.equal(planFulfilment({ bloodGroup: 'O+', units: 1 }, [unverified]).length, 0);
    assert.equal(
      planFulfilment({ bloodGroup: 'O+', units: 1 }, [unverified], { requireVerified: false }).length,
      1,
    );
  });

  test('a bank with no known location sorts last, not first', () => {
    // The request must carry a location, otherwise every bank ties on unknown
    // distance and the original order is preserved.
    const plan = planFulfilment(
      { bloodGroup: 'O+', units: 1, lat: BANJARA[0], lon: BANJARA[1] },
      [
        bank('unknown', null, null, { 'O+': 5 }),
        bank('known', BANJARA[0], BANJARA[1], { 'O+': 5 }),
      ],
    );
    assert.equal(plan[0].bankId, 'known');
    assert.equal(plan[1].bankId, 'unknown');
    assert.equal(plan[1].distanceKm, null, 'the unknown bank reports no distance');
  });

  test('maxDistanceKm filters out distant banks', () => {
    // The request needs a location, otherwise distance cannot be computed and
    // no bank can be excluded for being too far.
    const plan = planFulfilment(
      { bloodGroup: 'O+', units: 1, lat: BANJARA[0], lon: BANJARA[1] },
      banks,
      { maxDistanceKm: 5 },
    );
    assert.ok(plan.every((c) => c.bankId !== 'far'), 'the Kukatpally bank is over 5 km away');
  });

  test('a request with no location is not distance filtered', () => {
    // Nothing to compare against, so every qualifying bank stays in the plan.
    const plan = planFulfilment({ bloodGroup: 'O+', units: 1 }, banks, { maxDistanceKm: 1 });
    assert.ok(plan.length > 0);
  });

  test('a request for a negative group cannot be served from positive-only stock', () => {
    const plan = planFulfilment({ bloodGroup: 'O-', units: 1 }, [
      bank('positive-only', BANJARA[0], BANJARA[1], { 'O+': 10, 'A+': 10 }),
    ]);
    assert.equal(plan.length, 0, 'Rh positive must never serve an Rh negative recipient');
  });

  test('malformed input yields an empty plan rather than throwing', () => {
    assert.deepEqual(planFulfilment({ bloodGroup: '', units: 1 }, banks), []);
    assert.deepEqual(planFulfilment({ bloodGroup: 'O+', units: 0 }, banks), []);
    assert.deepEqual(planFulfilment({ bloodGroup: 'Z+', units: 1 }, banks), []);
    assert.deepEqual(planFulfilment(null, banks), []);
  });
});

describe('planDonorNotifications', () => {
  const donors = [
    { id: 'd1', name: 'Far exact', bloodGroup: 'O+', available: true, lat: KUKATPALLY[0], lon: KUKATPALLY[1] },
    { id: 'd2', name: 'Near universal', bloodGroup: 'O-', available: true, lat: BANJARA[0], lon: BANJARA[1] },
    { id: 'd3', name: 'Unavailable', bloodGroup: 'O+', available: false, lat: BANJARA[0], lon: BANJARA[1] },
    { id: 'd4', name: 'Incompatible', bloodGroup: 'A+', available: true, lat: BANJARA[0], lon: BANJARA[1] },
  ];

  test('unavailable and incompatible donors are both excluded', () => {
    const plan = planDonorNotifications({ bloodGroup: 'O+', lat: BANJARA[0], lon: BANJARA[1] }, donors);
    const ids = plan.map((m) => m.donor.id);
    assert.ok(!ids.includes('d3'), 'unavailable donor must be excluded');
    assert.ok(!ids.includes('d4'), 'incompatible donor must be excluded');
  });

  test('an exact match outranks a nearer universal donor at equal distance', () => {
    const same = [
      { id: 'uni', bloodGroup: 'O-', available: true, lat: BANJARA[0], lon: BANJARA[1] },
      { id: 'exact', bloodGroup: 'O+', available: true, lat: BANJARA[0], lon: BANJARA[1] },
    ];
    const plan = planDonorNotifications({ bloodGroup: 'O+', lat: BANJARA[0], lon: BANJARA[1] }, same);
    assert.equal(plan[0].donor.id, 'exact');
  });

  test('donors are ordered nearest first', () => {
    const plan = planDonorNotifications({ bloodGroup: 'O+', lat: GACHIBOWLI[0], lon: GACHIBOWLI[1] }, donors);
    assert.equal(plan[0].donor.id, 'd2', 'nearest donor should be notified first');
    assert.equal(plan[1].donor.id, 'd1');
  });
});
