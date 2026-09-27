import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDatabase, migrate, reset } from '../src/db/client.js';
import { reserveStock, releaseReservation, sweepAllExpired, InsufficientStockError, BankNotVerifiedError } from '../src/db/inventory.js';

/**
 * These run against a real PostgreSQL engine (PGlite, PostgreSQL 18.3 in WASM),
 * not a mock. The whole point of the design is that inventory cannot go
 * negative, and that guarantee lives in a CHECK constraint and a row lock. A
 * mock would prove nothing about either.
 */

let db;

const NOW = new Date('2026-09-27T10:00:00Z');
const at = (minutes) => new Date(NOW.getTime() + minutes * 60_000);

before(async () => {
  db = await createDatabase();
  await migrate(db);
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await reset(db);
  await db.exec(`
    INSERT INTO banks (id, name, city, state, verified_at)
    VALUES ('11111111-1111-1111-1111-111111111111', 'Verified Bank', 'Hyderabad', 'Telangana', '${NOW.toISOString()}'),
           ('22222222-2222-2222-2222-222222222222', 'Unverified Bank', 'Hyderabad', 'Telangana', NULL);

    INSERT INTO inventory (bank_id, blood_group, units) VALUES
      ('11111111-1111-1111-1111-111111111111', 'O-', 2),
      ('11111111-1111-1111-1111-111111111111', 'A+', 5);

    INSERT INTO requests (id, blood_group, units, hospital, status)
    VALUES ('33333333-3333-3333-3333-333333333333', 'O-', 2, 'Apollo Hospital', 'open');
  `);
});

const VERIFIED = '11111111-1111-1111-1111-111111111111';
const UNVERIFIED = '22222222-2222-2222-2222-222222222222';
const REQUEST = '33333333-3333-3333-3333-333333333333';

const unitsAt = async (group, bankId = VERIFIED) => {
  const rows = await db.query('SELECT units FROM inventory WHERE bank_id = $1 AND blood_group = $2', [bankId, group]);
  return Number(rows[0].units);
};

describe('reservation takes the stock it says it takes', () => {
  test('a full reservation succeeds and decrements exactly', async () => {
    const result = await reserveStock(db, {
      bankId: VERIFIED, requestId: REQUEST, bloodGroup: 'O-', units: 2, now: NOW,
    });
    assert.equal(result.units, 2);
    assert.equal(result.inventoryAfter, 0);
    assert.equal(await unitsAt('O-'), 0);
  });

  test('a partial reservation leaves the remainder alone', async () => {
    await reserveStock(db, { bankId: VERIFIED, requestId: REQUEST, bloodGroup: 'A+', units: 3, now: NOW });
    assert.equal(await unitsAt('A+'), 2);
  });

  test('the request is marked matched and attributed to the bank', async () => {
    await reserveStock(db, { bankId: VERIFIED, requestId: REQUEST, bloodGroup: 'O-', units: 1, now: NOW });
    const rows = await db.query('SELECT status, matched_bank_id FROM requests WHERE id = $1', [REQUEST]);
    assert.equal(rows[0].status, 'matched');
    assert.equal(rows[0].matched_bank_id, VERIFIED);
  });
});

describe('inventory can never go negative', () => {
  test('a reservation larger than stock is refused and changes nothing', async () => {
    await assert.rejects(
      () => reserveStock(db, { bankId: VERIFIED, requestId: REQUEST, bloodGroup: 'O-', units: 3, now: NOW }),
      InsufficientStockError,
    );
    assert.equal(await unitsAt('O-'), 2, 'a refused reservation must leave stock untouched');
  });

  test('the CHECK constraint refuses a direct negative write', async () => {
    // Belt and braces. Even if every line of application logic were wrong, the
    // database itself must refuse the write.
    await assert.rejects(() =>
      db.exec(`UPDATE inventory SET units = -1 WHERE bank_id = '${VERIFIED}' AND blood_group = 'O-'`),
    );
    assert.equal(await unitsAt('O-'), 2);
  });

  test('the second reservation of the same stock is refused', async () => {
    await reserveStock(db, { bankId: VERIFIED, requestId: REQUEST, bloodGroup: 'O-', units: 2, now: NOW });
    await assert.rejects(
      () => reserveStock(db, { bankId: VERIFIED, requestId: REQUEST, bloodGroup: 'O-', units: 1, now: NOW }),
      InsufficientStockError,
    );
    assert.equal(await unitsAt('O-'), 0);
  });

  test('a zero or negative unit count is rejected before touching the database', async () => {
    for (const units of [0, -1, 1.5, NaN]) {
      await assert.rejects(
        () => reserveStock(db, { bankId: VERIFIED, requestId: REQUEST, bloodGroup: 'O-', units, now: NOW }),
        RangeError,
      );
    }
  });
});

describe('only verified banks supply blood', () => {
  test('an unverified bank is refused', async () => {
    await assert.rejects(
      () => reserveStock(db, { bankId: UNVERIFIED, requestId: REQUEST, bloodGroup: 'O-', units: 1, now: NOW }),
      BankNotVerifiedError,
    );
  });

  test('an unknown bank is refused', async () => {
    // A syntactically valid UUID that simply is not in the banks table. Passing
    // a non UUID would fail on the column type before reaching the check.
    await assert.rejects(
      () =>
        reserveStock(db, {
          bankId: '99999999-9999-9999-9999-999999999999',
          requestId: REQUEST,
          bloodGroup: 'O-',
          units: 1,
          now: NOW,
        }),
      BankNotVerifiedError,
    );
  });
});

describe('reservations expire so stock is not held forever', () => {
  test('an expired reservation is recovered on the next reservation attempt', async () => {
    const first = await reserveStock(db, {
      bankId: VERIFIED, requestId: REQUEST, bloodGroup: 'O-', units: 2, now: NOW,
    });
    assert.equal(await unitsAt('O-'), 0, 'stock is held while the reservation is live');

    // Well past the 30 minute default TTL.
    const second = await reserveStock(db, {
      bankId: VERIFIED, requestId: REQUEST, bloodGroup: 'O-', units: 2, now: at(120),
    });
    assert.equal(second.expiredRecovered.unitsReturned, 2, 'the abandoned units came back');
    assert.equal(await unitsAt('O-'), 0, 'and were immediately re reserved');
    assert.ok(first.expiresAt);
  });

  test('a live reservation is not swept', async () => {
    await reserveStock(db, { bankId: VERIFIED, requestId: REQUEST, bloodGroup: 'O-', units: 2, now: NOW });
    const swept = await sweepAllExpired(db, { now: at(5) });
    assert.equal(swept.unitsReturned, 0);
    assert.equal(await unitsAt('O-'), 0, 'live stock stays held');
  });

  test('sweeping after expiry returns the units', async () => {
    await reserveStock(db, { bankId: VERIFIED, requestId: REQUEST, bloodGroup: 'O-', units: 2, now: NOW });
    const swept = await sweepAllExpired(db, { now: at(120) });
    assert.equal(swept.unitsReturned, 2);
    assert.equal(await unitsAt('O-'), 2);
  });

  test('a swept reservation is not swept twice', async () => {
    await reserveStock(db, { bankId: VERIFIED, requestId: REQUEST, bloodGroup: 'O-', units: 2, now: NOW });
    await sweepAllExpired(db, { now: at(120) });
    const again = await sweepAllExpired(db, { now: at(180) });
    assert.equal(again.unitsReturned, 0, 'recovered stock is not recovered twice');
    assert.equal(await unitsAt('O-'), 2);
  });
});

describe('cancelling a reservation returns the stock', () => {
  test('an early release puts the units back', async () => {
    const held = await reserveStock(db, {
      bankId: VERIFIED, requestId: REQUEST, bloodGroup: 'O-', units: 2, now: NOW,
    });
    assert.equal(await unitsAt('O-'), 0);

    const result = await releaseReservation(db, { reservationId: held.reservationId, now: at(5) });
    assert.equal(result.released, true);
    assert.equal(result.unitsReturned, 2);
    assert.equal(await unitsAt('O-'), 2);
  });

  test('releasing twice is refused, so stock cannot be duplicated', async () => {
    const held = await reserveStock(db, {
      bankId: VERIFIED, requestId: REQUEST, bloodGroup: 'O-', units: 1, now: NOW,
    });
    await releaseReservation(db, { reservationId: held.reservationId, now: at(5) });
    const second = await releaseReservation(db, { reservationId: held.reservationId, now: at(6) });
    assert.equal(second.released, false);
    assert.equal(second.reason, 'already_released');
    assert.equal(await unitsAt('O-'), 2, 'stock was returned once, not twice');
  });

  test('releasing a well formed but unknown reservation is a no op', async () => {
    // A valid UUID that is not in the table. Whether the id is even a UUID is a
    // question for the HTTP layer, which is where untrusted input arrives; down
    // here the assumption is well formed ids and nothing is duplicated.
    const result = await releaseReservation(db, {
      reservationId: '88888888-8888-8888-8888-888888888888',
      now: NOW,
    });
    assert.equal(result.released, false);
    assert.equal(result.reason, 'not_found');
  });
});

describe('contention for the same stock', () => {
  /**
   * A note on what these prove and what they do not.
   *
   * PGlite is a single connection. Three transactions issued in parallel
   * interleave their BEGIN and COMMIT on one handle, so the test runner cannot
   * produce genuine write contention here. Anything claiming to test parallel
   * reservation against PGlite is testing the harness, not the database.
   *
   * So the contention is driven sequentially, which does prove the safety
   * property that actually matters: no sequence of callers can take more units
   * than exist. The row lock exists to stop two callers *reading the same
   * figure before either writes*; the CHECK constraint is what makes the
   * invariant hold even if that lock were somehow bypassed. The constraint is
   * proven below against the real engine. The lock's benefit under true
   * parallelism needs a pooled PostgreSQL, and is not claimed until run there.
   */

  const THREE_REQUESTS = [
    '44444444-4444-4444-4444-444444444444',
    '55555555-5555-5555-5555-555555555555',
    '66666666-6666-6666-6666-666666666666',
  ];

  const seedThreeRequests = async () => {
    await db.exec(`
      INSERT INTO requests (id, blood_group, units, hospital, status) VALUES
        ('44444444-4444-4444-4444-444444444444', 'O-', 2, 'Hospital A', 'open'),
        ('55555555-5555-5555-5555-555555555555', 'O-', 2, 'Hospital B', 'open'),
        ('66666666-6666-6666-6666-666666666666', 'O-', 2, 'Hospital C', 'open')
    `);
  };

  test('three requests wanting two units each cannot take more than the two that exist', async () => {
    // Two units on the shelf, three requests each wanting two.
    await seedThreeRequests();

    const outcomes = [];
    for (const id of THREE_REQUESTS) {
      try {
        await reserveStock(db, { bankId: VERIFIED, requestId: id, bloodGroup: 'O-', units: 2, now: NOW });
        outcomes.push({ id, ok: true });
      } catch (err) {
        outcomes.push({ id, ok: false, err });
      }
    }

    const fulfilled = outcomes.filter((o) => o.ok);
    const refused = outcomes.filter((o) => !o.ok);

    assert.equal(fulfilled.length, 1, 'exactly one request can hold the two units');
    assert.equal(refused.length, 2, 'the other two are refused');
    assert.ok(
      refused.every((o) => o.err instanceof InsufficientStockError),
      'and refused for the right reason, not some unrelated database error',
    );
    assert.equal(await unitsAt('O-'), 0, 'stock lands on zero, never below');

    const held = await db.query('SELECT count(*)::int c FROM reservations WHERE released = false');
    assert.equal(held[0].c, 1, 'and only one reservation survives');
  });

  test('the surviving request is left matched and the refused ones are left open', async () => {
    // A refused reservation must not half apply. If it did, a hospital could be
    // told the blood is theirs when the transaction was rolled back.
    await seedThreeRequests();

    const results = [];
    for (const id of THREE_REQUESTS) {
      try {
        await reserveStock(db, { bankId: VERIFIED, requestId: id, bloodGroup: 'O-', units: 2, now: NOW });
        results.push({ id, ok: true });
      } catch {
        results.push({ id, ok: false });
      }
    }

    const rows = await db.query('SELECT id, status, matched_bank_id FROM requests ORDER BY id');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    for (const r of results) {
      if (r.ok) {
        assert.equal(byId[r.id].status, 'matched', 'the holder is marked matched');
        assert.equal(byId[r.id].matched_bank_id, VERIFIED);
      } else {
        assert.equal(byId[r.id].status, 'open', 'a refused request is untouched, not half applied');
        assert.equal(byId[r.id].matched_bank_id, null, 'and is not attributed to any bank');
      }
    }
  });

  test('a rolled back reservation leaves no trace at all', async () => {
    // The transaction is all or nothing. If an error after the decrement did not
    // roll the decrement back, the units would be lost silently, which is how a
    // blood bank ends up short without knowing why.
    await seedThreeRequests();

    const requestWithBadForeignKey = '77777777-7777-7777-7777-777777777777';
    await assert.rejects(() =>
      reserveStock(db, {
        bankId: VERIFIED,
        requestId: requestWithBadForeignKey, // no such request row
        bloodGroup: 'A+',
        units: 2,
        now: NOW,
      }),
    );

    assert.equal(await unitsAt('A+'), 5, 'the decrement was rolled back with the rest of the transaction');
    const reservations = await db.query('SELECT count(*)::int c FROM reservations');
    assert.equal(reservations[0].c, 0, 'and no reservation row was left behind');
  });
});
