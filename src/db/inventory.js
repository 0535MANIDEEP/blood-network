/**
 * Inventory reservation.
 *
 * This is the transaction that decides whether blood is actually held for
 * someone. Everything else in the system is advisory; this is the part that must
 * be correct, because getting it wrong means two hospitals are told the last two
 * units of O negative are theirs.
 *
 * Three separate mechanisms, deliberately not one:
 *
 *   1. SELECT ... FOR UPDATE on the inventory row. Serialises concurrent
 *      reservations for the same bank and group, so two callers cannot both read
 *      the same stock figure before either writes.
 *   2. A CHECK (units >= 0) constraint on the column. Even if the application
 *      logic were wrong, the database refuses the write. Belt and braces,
 *      because this is the one invariant that must never be broken.
 *   3. A reservation row with an expiry. Without it a bank can sit on the last
 *      units indefinitely and nobody else can use them, which wastes blood and
 *      is how a real blood bank ends up with expired stock on the shelf.
 *
 * Expiry is swept before every reservation, so recovering abandoned stock is not
 * a background job that can fail to run.
 */

const DEFAULT_TTL_MINUTES = 30;

export class InsufficientStockError extends Error {
  constructor(requested, available) {
    super(`Requested ${requested} unit(s) but only ${available} available.`);
    this.name = 'InsufficientStockError';
    this.requested = requested;
    this.available = available;
  }
}

export class BankNotVerifiedError extends Error {
  constructor(bankId) {
    super(`Bank ${bankId} is not verified, so its stock cannot be used.`);
    this.name = 'BankNotVerifiedError';
  }
}

/**
 * Return units held by reservations that have timed out.
 *
 * Runs inside the caller's transaction, after the lock is taken, so a unit cannot
 * be returned to stock by a sweep while another transaction is reading it.
 */
async function releaseExpired(db, bankId, bloodGroup, now) {
  const expired = await db.query(
    `SELECT id, units FROM reservations
      WHERE bank_id = $1 AND blood_group = $2 AND released = false AND expires_at <= $3
      FOR UPDATE`,
    [bankId, bloodGroup, now],
  );

  if (expired.length === 0) return { released: 0, unitsReturned: 0 };

  const units = expired.reduce((sum, r) => sum + r.units, 0);

  await db.query(
    `UPDATE reservations SET released = true
      WHERE bank_id = $1 AND blood_group = $2 AND released = false AND expires_at <= $3`,
    [bankId, bloodGroup, now],
  );

  await db.query(
    `UPDATE inventory SET units = units + $4, updated_at = $3
      WHERE bank_id = $1 AND blood_group = $2`,
    [bankId, bloodGroup, now, units],
  );

  return { released: expired.length, unitsReturned: units };
}

/**
 * Hold stock for a request.
 *
 * Either the full quantity is held or nothing is. There is no partial
 * reservation, because a hospital told "we have reserved one of the two units
 * you asked for" cannot plan around that.
 *
 * @returns {{ reservationId, units, expiresAt, inventoryAfter }}
 */
export async function reserveStock(db, { bankId, requestId, bloodGroup, units, ttlMinutes = DEFAULT_TTL_MINUTES, now = new Date() }) {
  if (!Number.isInteger(units) || units < 1) {
    throw new RangeError('units must be a positive integer');
  }

  const group = String(bloodGroup).trim().toUpperCase();

  return db.transaction(async (tx) => {
    const verified = await tx.query(`SELECT verified_at FROM banks WHERE id = $1`, [bankId]);
    if (verified.length === 0) {
      throw new BankNotVerifiedError(bankId);
    }
    if (!verified[0].verified_at) {
      throw new BankNotVerifiedError(bankId);
    }

    // Lock first, then sweep. The other order lets a sweep return stock that a
    // concurrent transaction has already read as available.
    const locked = await tx.query(
      `SELECT units FROM inventory WHERE bank_id = $1 AND blood_group = $2 FOR UPDATE`,
      [bankId, group],
    );

    if (locked.length === 0) {
      throw new InsufficientStockError(units, 0);
    }

    const sweep = await releaseExpired(tx, bankId, group, now);

    // Re-read after the sweep, because the sweep may have returned units.
    const current = await tx.query(
      `SELECT units FROM inventory WHERE bank_id = $1 AND blood_group = $2`,
      [bankId, group],
    );
    const available = Number(current[0].units) + 0;

    if (available < units) {
      throw new InsufficientStockError(units, available);
    }

    // The CHECK constraint is the real guarantee. If this ever drives units
    // below zero the statement fails and the transaction rolls back, whatever
    // the arithmetic above did.
    await tx.query(
      `UPDATE inventory SET units = units - $3, updated_at = $4
        WHERE bank_id = $1 AND blood_group = $2`,
      [bankId, group, units, now],
    );

    const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);
    const inserted = await tx.query(
      `INSERT INTO reservations (request_id, bank_id, blood_group, units, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, expires_at`,
      [requestId, bankId, group, units, expiresAt],
    );

    await tx.query(
      `UPDATE requests SET status = 'matched', matched_bank_id = $2, updated_at = $3
        WHERE id = $1`,
      [requestId, bankId, now],
    );

    return {
      reservationId: inserted[0].id,
      units,
      expiresAt: inserted[0].expires_at,
      inventoryAfter: available - units,
      expiredRecovered: sweep,
    };
  });
}

/** Give stock back before the reservation expires, for example on cancellation. */
export async function releaseReservation(db, { reservationId, now = new Date() }) {
  return db.transaction(async (tx) => {
    const rows = await tx.query(
      `SELECT bank_id, blood_group, units, released FROM reservations
        WHERE id = $1 FOR UPDATE`,
      [reservationId],
    );
    if (rows.length === 0) return { released: false, reason: 'not_found' };
    if (rows[0].released) return { released: false, reason: 'already_released' };

    await tx.query(`UPDATE reservations SET released = true WHERE id = $1`, [reservationId]);
    await tx.query(
      `UPDATE inventory SET units = units + $3, updated_at = $4
        WHERE bank_id = $1 AND blood_group = $2`,
      [rows[0].bank_id, rows[0].blood_group, rows[0].units, now],
    );
    await tx.query(`UPDATE requests SET status = 'open', matched_bank_id = NULL, updated_at = $1 WHERE id = $2`, [
      now,
      (await tx.query(`SELECT request_id FROM reservations WHERE id = $1`, [reservationId]))[0]?.request_id,
    ]);

    return { released: true, unitsReturned: rows[0].units };
  });
}

/** Sweep every bank for expired reservations. */
export async function sweepAllExpired(db, { now = new Date() } = {}) {
  return db.transaction(async (tx) => {
    const stale = await tx.query(
      `SELECT DISTINCT bank_id, blood_group FROM reservations
        WHERE released = false AND expires_at <= $1`,
      [now],
    );

    let totalUnits = 0;
    for (const row of stale) {
      const result = await releaseExpired(tx, row.bank_id, row.blood_group, now);
      totalUnits += result.unitsReturned;
    }
    return { groups: stale.length, unitsReturned: totalUnits };
  });
}
