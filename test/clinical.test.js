import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { assessDonorEligibility, canDonateAgain, assertNoPaymentOffered, DEFER } from '../src/domain/eligibility.js';
import { REGULATORY_POLICY, assertPolicyReviewed, deferralDaysFor } from '../src/policy/regulatory.js';
import { isUnitUsable, orderFEFO, expiringSoon, shelfLifeDays, storageRequirement } from '../src/domain/shelfLife.js';
import { canDonateRedCells, canDonatePlasma, donorPreferenceFlags, plasmaDonorGroupsFor } from '../src/domain/compatibility.js';

const NOW = new Date('2026-09-27T00:00:00Z');
const P = REGULATORY_POLICY.donor;

/** A donor who passes everything, so each test can spoil exactly one field. */
const healthyDonor = (over = {}) => ({
  dob: '1998-04-12',
  sex: 'male',
  weightKg: 72,
  haemoglobin: 15,
  pulse: 72,
  systolic: 120,
  diastolic: 80,
  temperatureC: 36.8,
  isFirstDonation: true,
  declarations: {},
  ...over,
});

const reasonsOf = (result) => result.reasons.map((r) => r.reason);

describe('regulatory policy is not silently trusted', () => {
  test('the policy is flagged unreviewed', () => {
    assert.equal(REGULATORY_POLICY.reviewed, false, 'must not claim verification it does not have');
  });

  test('production startup refuses to run on an unreviewed policy', () => {
    assert.throws(() => assertPolicyReviewed({ isProduction: true }), /unreviewed/i);
  });

  test('non production startup is allowed but warns', () => {
    assert.doesNotThrow(() => assertPolicyReviewed({ isProduction: false }));
  });

  test('every named source is marked unconfirmed', () => {
    for (const source of Object.values(REGULATORY_POLICY.sources)) {
      assert.match(source, /UNCONFIRMED/, `"${source}" must carry the unconfirmed marker`);
    }
  });
});

describe('assessDonorEligibility, happy path', () => {
  test('a healthy first time donor is eligible', () => {
    const r = assessDonorEligibility(healthyDonor(), NOW);
    assert.equal(r.outcome, 'eligible');
    assert.deepEqual(r.reasons, []);
  });

  test('the result reports that the policy behind it is unreviewed', () => {
    const r = assessDonorEligibility(healthyDonor(), NOW);
    assert.equal(r.policyReviewed, false, 'a caller must be able to see the caveat');
  });
});

describe('assessDonorEligibility fails safe on every unknown', () => {
  test('an empty record defers rather than passing', () => {
    assert.equal(assessDonorEligibility({}, NOW).outcome, DEFER);
    assert.equal(assessDonorEligibility(null, NOW).outcome, DEFER);
  });

  test('each missing field on its own is enough to defer', () => {
    // A screening form that silently accepts blanks eventually lets an unsafe
    // donor through, and the blank is always the thing nobody checked.
    const fields = ['dob', 'weightKg', 'haemoglobin', 'pulse', 'systolic', 'diastolic', 'temperatureC'];
    for (const field of fields) {
      const donor = healthyDonor();
      delete donor[field];
      const r = assessDonorEligibility(donor, NOW);
      assert.equal(r.outcome, DEFER, `missing ${field} must defer`);
      assert.ok(
        reasonsOf(r).some((x) => x.endsWith('_unknown')),
        `missing ${field} should report an unknown, got ${reasonsOf(r).join(',')}`,
      );
    }
  });

  test('an unparseable date of birth defers', () => {
    assert.equal(assessDonorEligibility(healthyDonor({ dob: 'not-a-date' }), NOW).outcome, DEFER);
  });

  test('an unknown haemoglobin is never treated as a pass', () => {
    assert.equal(REGULATORY_POLICY.donor.haemoglobin.unknownIsAcceptable, false);
    const donor = healthyDonor();
    donor.haemoglobin = null;
    assert.ok(reasonsOf(assessDonorEligibility(donor, NOW)).includes('haemoglobin_unknown'));
  });
});

describe('assessDonorEligibility thresholds', () => {
  test('age bounds are inclusive at the limit and exclusive outside it', () => {
    const atMin = healthyDonor({ dob: '2008-09-27' }); // exactly 18
    assert.ok(!reasonsOf(assessDonorEligibility(atMin, NOW)).includes('too_young'));

    const under = healthyDonor({ dob: '2009-01-01' });
    assert.ok(reasonsOf(assessDonorEligibility(under, NOW)).includes('too_young'));
  });

  test('a first time donor is held to the stricter age cap', () => {
    const dob = '1961-01-01'; // 65 in 2026
    const firstTime = assessDonorEligibility(healthyDonor({ dob, isFirstDonation: true }), NOW);
    assert.ok(reasonsOf(firstTime).includes('too_old'), 'first time cap is lower');

    const returning = assessDonorEligibility(healthyDonor({ dob, isFirstDonation: false, lastDonationDate: '2026-01-01' }), NOW);
    assert.ok(!reasonsOf(returning).includes('too_old'), 'returning donor may use the higher cap');
  });

  test('weight, haemoglobin and temperature thresholds', () => {
    assert.ok(reasonsOf(assessDonorEligibility(healthyDonor({ weightKg: 49 }), NOW)).includes('below_min_weight'));
    assert.ok(reasonsOf(assessDonorEligibility(healthyDonor({ haemoglobin: 12.4 }), NOW)).includes('haemoglobin_low'));
    assert.ok(reasonsOf(assessDonorEligibility(healthyDonor({ temperatureC: 38.2 }), NOW)).includes('fever'));
  });

  test('the haemoglobin floor is higher for males than females', () => {
    const male = assessDonorEligibility(healthyDonor({ sex: 'male', haemoglobin: 12.6 }), NOW);
    const female = assessDonorEligibility(healthyDonor({ sex: 'female', haemoglobin: 12.6 }), NOW);
    assert.ok(reasonsOf(male).includes('haemoglobin_low'), '12.6 is below the male floor');
    assert.ok(!reasonsOf(female).includes('haemoglobin_low'), '12.6 clears the female floor');
  });

  test('out of range vitals defer', () => {
    assert.ok(reasonsOf(assessDonorEligibility(healthyDonor({ pulse: 130 }), NOW)).includes('pulse_out_of_range'));
    assert.ok(reasonsOf(assessDonorEligibility(healthyDonor({ systolic: 150 }), NOW)).includes('systolic_out_of_range'));
  });
});

describe('assessDonorEligibility deferral history', () => {
  test('a permanent history is a permanent deferral', () => {
    for (const condition of REGULATORY_POLICY.donor.selfDeclaration.permanentDeferral) {
      const donor = healthyDonor({ declarations: { permanentHistory: [condition] } });
      const r = assessDonorEligibility(donor, NOW);
      assert.ok(reasonsOf(r).includes('permanent_history'), `${condition} must defer`);
    }
  });

  test('recent events defer', () => {
    const cases = [
      [{ feverWeeksAgo: 1 }, 'recent_fever'],
      [{ antibioticsDaysAgo: 2 }, 'recent_antibiotics'],
      [{ tattooMonthsAgo: 1 }, 'recent_tattoo'],
      [{ surgeryMonthsAgo: 2 }, 'recent_surgery'],
    ];
    for (const [declarations, expected] of cases) {
      const r = assessDonorEligibility(healthyDonor({ declarations }), NOW);
      assert.ok(reasonsOf(r).includes(expected), `${JSON.stringify(declarations)} -> ${expected}`);
    }
  });

  test('an event older than the window does not defer', () => {
    const r = assessDonorEligibility(
      healthyDonor({ declarations: { feverWeeksAgo: 10, antibioticsDaysAgo: 30 } }),
      NOW,
    );
    assert.equal(r.outcome, 'eligible');
  });

  test('a postpartum donor inside the window defers', () => {
    const r = assessDonorEligibility(
      healthyDonor({ sex: 'female', declarations: { weeksPostpartum: 4 } }),
      NOW,
    );
    assert.ok(reasonsOf(r).includes('recent_pregnancy'));
  });
});

describe('donation interval', () => {
  test('a returning donor inside the interval defers', () => {
    const donor = healthyDonor({
      isFirstDonation: false,
      lastDonationDate: '2026-08-15', // 43 days ago
      previousDonorSex: 'male',
    });
    assert.ok(reasonsOf(assessDonorEligibility(donor, NOW)).includes('interval_too_short'));
  });

  test('a returning donor outside the interval is eligible', () => {
    const donor = healthyDonor({
      isFirstDonation: false,
      lastDonationDate: '2026-03-01',
      previousDonorSex: 'male',
    });
    assert.equal(assessDonorEligibility(donor, NOW).outcome, 'eligible');
  });

  test('a returning donor with no recorded last donation defers', () => {
    const donor = healthyDonor({ isFirstDonation: false, lastDonationDate: null });
    assert.ok(reasonsOf(assessDonorEligibility(donor, NOW)).includes('last_donation_unknown'));
  });

  test('the interval is longer where a female donor gave', () => {
    assert.ok(deferralDaysFor('male', 'female') > deferralDaysFor('male', 'male'));
    assert.equal(deferralDaysFor('male', 'male'), P.deferralDays.maleToMale);
  });

  test('canDonateAgain reports the shortfall', () => {
    const r = canDonateAgain({ isFirstDonation: false, sex: 'male', previousDonorSex: 'male', lastDonationDate: '2026-08-15' }, NOW);
    assert.equal(r.allowed, false);
    assert.equal(r.required, 90);
  });
});

describe('payment for donation is blocked', () => {
  test('an ordinary action passes', () => {
    assert.equal(assertNoPaymentOffered({ type: 'register', channel: 'whatsapp' }), true);
  });

  test('any monetary incentive is refused', () => {
    for (const word of ['payment', 'reward', 'cash', 'voucher', 'reimbursement', 'incentive']) {
      assert.throws(
        () => assertNoPaymentOffered({ type: 'donor_complete', offer: word }),
        /prohibited/i,
        `"${word}" must be blocked`,
      );
    }
  });
});

describe('component shelf life', () => {
  test('components have different lives, not one blanket default', () => {
    assert.ok(shelfLifeDays('platelets') < shelfLifeDays('packed_red_cells'));
    assert.ok(shelfLifeDays('fresh_frozen_plasma') > shelfLifeDays('packed_red_cells'));
  });

  test('an unknown component is treated as unusable, never fresh', () => {
    assert.equal(shelfLifeDays('unobtainium'), 0);
    assert.equal(isUnitUsable('unobtainium', '2026-09-20', NOW), false);
  });

  test('an unreadable collection date is unusable', () => {
    assert.equal(isUnitUsable('packed_red_cells', 'not-a-date', NOW), false);
  });

  test('a unit inside its life is usable and one past it is not', () => {
    assert.equal(isUnitUsable('platelets', '2026-09-25', NOW), true, '2 days old platelets are fine');
    assert.equal(isUnitUsable('platelets', '2026-09-01', NOW), false, '26 days old platelets are not');
  });

  test('storage requirement is reported for a known component only', () => {
    assert.match(storageRequirement('platelets'), /room temperature/);
    assert.match(storageRequirement('unobtainium'), /do not issue/);
  });
});

describe('FEFO ordering', () => {
  const units = [
    { id: 'fresh-frozen', component: 'fresh_frozen_plasma', collectedAt: '2026-01-01', units: 2 },
    { id: 'platelets', component: 'platelets', collectedAt: '2026-09-24', units: 1 },
    { id: 'red-cells', component: 'packed_red_cells', collectedAt: '2026-09-10', units: 3 },
  ];

  test('the unit expiring soonest is issued first', () => {
    assert.deepEqual(orderFEFO(units, NOW).map((u) => u.id), ['platelets', 'red-cells', 'fresh-frozen']);
  });

  test('FEFO does not simply pick the oldest collected', () => {
    const order = orderFEFO(units, NOW).map((u) => u.id);
    assert.notEqual(order[0], 'fresh-frozen', 'the oldest collected is the longest lived');
  });

  test('already expired units sink to the bottom', () => {
    const withExpired = [...units, { id: 'stale', component: 'platelets', collectedAt: '2026-01-01', units: 1 }];
    assert.equal(orderFEFO(withExpired, NOW).at(-1).id, 'stale');
  });

  test('expiringSoon surfaces the short dated units', () => {
    assert.deepEqual(expiringSoon(units, 7, NOW).map((u) => u.id), ['platelets']);
  });

  test('malformed input does not throw', () => {
    assert.deepEqual(orderFEFO(null, NOW), []);
    assert.deepEqual(orderFEFO([null, undefined], NOW), []);
  });
});

describe('plasma compatibility is not red cell compatibility', () => {
  test('AB negative is the universal plasma donor', () => {
    for (const recipient of ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-']) {
      assert.equal(canDonatePlasma('AB-', recipient), true, `AB- plasma -> ${recipient}`);
    }
  });

  test('O plasma is the most restricted and only suits O', () => {
    assert.equal(canDonatePlasma('O+', 'O-'), true);
    for (const recipient of ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-']) {
      assert.equal(canDonatePlasma('O+', recipient), false, `O+ plasma -> ${recipient}`);
    }
  });

  test('A plasma suits A and O only', () => {
    assert.equal(canDonatePlasma('A+', 'A-'), true);
    assert.equal(canDonatePlasma('A+', 'O+'), true);
    assert.equal(canDonatePlasma('A+', 'B+'), false);
    assert.equal(canDonatePlasma('A+', 'AB+'), false);
  });

  test('plasma ignores Rh, because there are no red cells to react to', () => {
    assert.equal(canDonatePlasma('AB-', 'AB+'), true);
    assert.equal(canDonatePlasma('A-', 'A+'), true);
  });

  test('the two rules genuinely disagree, which is why they are separate functions', () => {
    // O- red cells suit everyone; O- plasma suits only O. Same donor, opposite rules.
    assert.equal(canDonateRedCells('O-', 'AB+'), true);
    assert.equal(canDonatePlasma('O-', 'AB+'), false);
    // And the universal plasma donor cannot donate red cells to everyone.
    assert.equal(canDonateRedCells('AB-', 'O+'), false);
    assert.equal(canDonatePlasma('AB-', 'O+'), true);
  });

  test('plasma donor table is correct for an O recipient', () => {
    assert.deepEqual(new Set(plasmaDonorGroupsFor('O+')), new Set(['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-']));
  });
});

describe('alloimmunisation preference flags', () => {
  test('Rh positive to an Rh negative woman of childbearing age is flagged', () => {
    const flags = donorPreferenceFlags({
      donor: 'O+',
      recipient: 'O-',
      recipientSex: 'female',
      recipientAgeYears: 28,
    });
    assert.ok(flags.some((f) => f.code === 'alloimmunisation_risk'));
  });

  test('the same pairing for a male recipient is not flagged for that reason', () => {
    const flags = donorPreferenceFlags({
      donor: 'O+',
      recipient: 'O-',
      recipientSex: 'male',
      recipientAgeYears: 28,
    });
    assert.ok(!flags.some((f) => f.code === 'alloimmunisation_risk'));
  });

  test('a non same group match is always surfaced for the reviewer', () => {
    const flags = donorPreferenceFlags({ donor: 'O-', recipient: 'A+' });
    assert.ok(flags.some((f) => f.code === 'not_same_group'));
  });

  test('an exact match raises no flags', () => {
    assert.deepEqual(
      donorPreferenceFlags({ donor: 'A+', recipient: 'A+', recipientSex: 'male', recipientAgeYears: 30 }),
      [],
    );
  });
});
