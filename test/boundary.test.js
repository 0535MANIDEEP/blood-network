import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertWithinBoundary,
  enforceBoundary,
  assertNoClinicalClaim,
  requiredDisclaimer,
  BLOCKERS,
  BOUNDARY_STATEMENT,
} from '../src/policy/boundary.js';

const cleanOptions = {
  isProduction: false,
  env: {},
  policyReviewed: false,
  seedMode: true,
  notifyRecipients: 'fixtures',
};

const codes = (result) => result.blockers.map((b) => b.code);

describe('student project boundary', () => {
  test('a seeded, fixture-only project is within boundary', () => {
    const r = assertWithinBoundary(cleanOptions);
    assert.equal(r.withinBoundary, true);
    assert.deepEqual(r.blockers, []);
  });

  test('the disclaimer is present and says what this is not', () => {
    const text = requiredDisclaimer();
    assert.match(text, /not a blood bank/i);
    assert.match(text, /not a medical device/i);
    assert.match(text, /synthetic data/i);
    assert.equal(text, BOUNDARY_STATEMENT);
  });
});

describe('real patient data is refused', () => {
  test('loading real records is a blocker', () => {
    const r = assertWithinBoundary({ ...cleanOptions, seedMode: false });
    assert.equal(r.withinBoundary, false);
    assert.ok(codes(r).includes(BLOCKERS.REAL_PATIENT_DATA));
  });

  test('enforceBoundary throws rather than warning', () => {
    assert.throws(() => enforceBoundary({ ...cleanOptions, seedMode: false }), /boundary violated/i);
  });
});

describe('real bank supply is refused', () => {
  test('a non fixture supply mode is a blocker', () => {
    const r = assertWithinBoundary({ ...cleanOptions, env: { BANK_SUPPLY_MODE: 'live' } });
    assert.ok(codes(r).includes(BLOCKERS.REAL_BANK_SUPPLY));
  });

  test('fixtures are allowed', () => {
    const r = assertWithinBoundary({ ...cleanOptions, env: { BANK_SUPPLY_MODE: 'fixtures' } });
    assert.equal(r.withinBoundary, true);
  });
});

describe('notifications to real phones are refused', () => {
  test('any recipient list that is not fixtures is a blocker', () => {
    for (const recipients of ['real', 'opted_in_users', 'phone_numbers']) {
      const r = assertWithinBoundary({ ...cleanOptions, notifyRecipients: recipients });
      assert.ok(codes(r).includes(BLOCKERS.REAL_NOTIFICATIONS), `${recipients} must be blocked`);
    }
  });

  test('fixtures and none are both allowed', () => {
    assert.equal(assertWithinBoundary({ ...cleanOptions, notifyRecipients: 'none' }).withinBoundary, true);
    assert.equal(assertWithinBoundary(cleanOptions).withinBoundary, true);
  });
});

describe('production needs a reviewed policy', () => {
  test('a public deployment with an unreviewed policy is a blocker', () => {
    const r = assertWithinBoundary({ ...cleanOptions, isProduction: true });
    assert.ok(codes(r).includes(BLOCKERS.UNREVIEWED_POLICY));
  });

  test('a reviewed policy clears it', () => {
    const r = assertWithinBoundary({ ...cleanOptions, isProduction: true, policyReviewed: true });
    assert.equal(r.withinBoundary, true);
  });
});

describe('the override is not a bypass', () => {
  test('setting the env var without a reviewed policy still fails', () => {
    // This is the whole point. A stray commit or a well meaning contributor
    // flipping one variable must not be enough to open a real deployment.
    assert.throws(
      () => assertWithinBoundary({ ...cleanOptions, isProduction: true, env: { ALLOW_REAL_DATA: 'true' } }),
      /both are required/i,
    );
  });

  test('the override only applies with a reviewed policy', () => {
    const r = assertWithinBoundary({
      isProduction: true,
      env: { ALLOW_REAL_DATA: 'true' },
      policyReviewed: true,
    });
    assert.equal(r.override, true);
    assert.equal(r.withinBoundary, false);
  });

  test('any other value for the env var is not an override', () => {
    for (const value of ['1', 'yes', 'TRUE ', 'on', 'please']) {
      const r = assertWithinBoundary({ ...cleanOptions, env: { ALLOW_REAL_DATA: value } });
      assert.equal(r.override, false, `"${value}" must not unlock anything`);
    }
  });
});

describe('clinical claims are refused', () => {
  test('ordinary descriptive copy passes', () => {
    assert.equal(assertNoClinicalClaim('Matching O negative donors to an O negative request.'), true);
    assert.equal(assertNoClinicalClaim('Compatible by red cell rules. Verify clinically before use.'), true);
  });

  test('every banned claim is caught', () => {
    const claims = [
      'This unit is safe to transfuse',
      'Sterile donation',
      'Approved for transfusion',
      'transfusion-ready component',
      'clinically proven matching',
      'medically certified',
      'guaranteed match',
      'a cure for anaemia',
      'lifesaving app',
    ];
    for (const claim of claims) {
      assert.throws(() => assertNoClinicalClaim(claim), /clinical claim/i, `"${claim}" must be blocked`);
    }
  });

  test('the check is case insensitive', () => {
    assert.throws(() => assertNoClinicalClaim('STERILE AND APPROVED FOR TRANSFUSION'), /clinical claim/i);
  });

  test('non strings do not throw', () => {
    assert.equal(assertNoClinicalClaim(null), true);
    assert.equal(assertNoClinicalClaim(undefined), true);
  });
});
