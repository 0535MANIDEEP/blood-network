import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  canDonate,
  donorGroupsFor,
  rankDonorGroup,
  isValidGroup,
  isPastShelfLife,
  BLOOD_GROUPS,
} from '../src/domain/compatibility.js';

const asSet = (values) => new Set(values);

describe('canDonate', () => {
  test('O negative donates to every group', () => {
    for (const recipient of BLOOD_GROUPS) {
      assert.equal(canDonate('O-', recipient), true, `O- -> ${recipient}`);
    }
  });

  test('AB positive donates only to AB positive', () => {
    for (const recipient of BLOOD_GROUPS) {
      assert.equal(canDonate('AB+', recipient), recipient === 'AB+', `AB+ -> ${recipient}`);
    }
  });

  test('positive blood never reaches a negative recipient', () => {
    const positives = ['O+', 'A+', 'B+', 'AB+'];
    const negatives = ['O-', 'A-', 'B-', 'AB-'];
    for (const donor of positives) {
      for (const recipient of negatives) {
        assert.equal(canDonate(donor, recipient), false, `${donor} -> ${recipient} must be blocked`);
      }
    }
  });

  test('negative blood may reach a positive recipient', () => {
    // Removing this is how O negative stops being universal.
    for (const [donor, recipient] of [
      ['O-', 'O+'],
      ['A-', 'A+'],
      ['B-', 'B+'],
      ['AB-', 'AB+'],
    ]) {
      assert.equal(canDonate(donor, recipient), true, `${donor} -> ${recipient}`);
    }
  });

  test('AB is compared in full, not by its first letter', () => {
    // The bug this guards: treating AB as A would wrongly let AB+ give to A+.
    assert.equal(canDonate('AB+', 'A+'), false);
    assert.equal(canDonate('AB-', 'A-'), false);
    assert.equal(canDonate('AB+', 'AB+'), true);
    assert.equal(canDonate('AB-', 'AB+'), true);
  });

  test('antigen must match unless the donor is O', () => {
    assert.equal(canDonate('A-', 'B+'), false);
    assert.equal(canDonate('B-', 'A+'), false);
    assert.equal(canDonate('A-', 'A-'), true);
    assert.equal(canDonate('O+', 'AB-'), false, 'positive O cannot give to a negative recipient');
  });

  test('input is normalised and invalid values are rejected', () => {
    assert.equal(canDonate('o-', 'o+'), true);
    assert.equal(canDonate('  ab-  ', 'AB+'), true);
    assert.equal(canDonate('', 'O+'), false);
    assert.equal(canDonate('Z+', 'O+'), false);
    assert.equal(canDonate(null, 'O+'), false);
    assert.equal(isValidGroup('a+'), true);
    assert.equal(isValidGroup('A'), false);
  });
});

describe('donorGroupsFor', () => {
  test('the full recipient table', () => {
    const expected = {
      'O-': ['O-'],
      'O+': ['O-', 'O+'],
      'A-': ['O-', 'A-'],
      'A+': ['O-', 'O+', 'A-', 'A+'],
      'B-': ['O-', 'B-'],
      'B+': ['O-', 'O+', 'B-', 'B+'],
      'AB-': ['O-', 'AB-'],
      'AB+': ['O-', 'O+', 'AB-', 'AB+'],
    };
    for (const [recipient, donors] of Object.entries(expected)) {
      assert.deepEqual(asSet(donorGroupsFor(recipient)), asSet(donors), `donors for ${recipient}`);
    }
  });
});

describe('rankDonorGroup', () => {
  test('an exact match outranks a universal donor', () => {
    assert.equal(rankDonorGroup('O+', 'O+'), 0);
    assert.equal(rankDonorGroup('O-', 'O+'), 1);
  });
});

describe('isPastShelfLife', () => {
  const now = new Date('2026-09-27T00:00:00Z');

  test('a unit inside its shelf life is usable', () => {
    assert.equal(isPastShelfLife('2026-09-01T00:00:00Z', 35, now), false);
  });

  test('a unit past its shelf life is not usable', () => {
    assert.equal(isPastShelfLife('2026-07-01T00:00:00Z', 35, now), true);
  });

  test('an unparseable date is treated as expired rather than fresh', () => {
    // Failing open here would put an unknown-age unit into a patient.
    assert.equal(isPastShelfLife('not-a-date', 35, now), true);
  });
});
