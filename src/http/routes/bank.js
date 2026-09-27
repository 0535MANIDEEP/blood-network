import { Router } from 'express';

import { requireAuth, requireRole, validate, validateParams, schemas } from '../middleware.js';
import { presentRequestList, presentBank } from '../present.js';
import { assertCan } from '../../auth/rbac.js';
import { reserveStock } from '../../db/inventory.js';
import { requiredDisclaimer } from '../../policy/boundary.js';
import { badRequest, notFound } from '../errors.js';

/**
 * Bank side.
 *
 * Every route here is scoped to the caller's own bank, enforced by assertCan
 * rather than by trusting a bank id from the request body. The tempting
 * alternative, "look up the bank by the id in the payload", is how one blood
 * bank ends up adjusting another's stock, and it looks completely reasonable in
 * review because there is nothing obviously wrong with it.
 */
export function bankRoutes({ db } = {}) {
  const router = Router();

  router.use(requireAuth, requireRole('bank'));

  /** The caller's own bank, and their right to act on it. */
  const ownBank = async (req) => {
    const bankId = req.user.subjectId;
    assertCan(req.user, 'inventory:read:own', { bankId });

    const rows = await db.query('SELECT * FROM banks WHERE id = $1', [bankId]);
    if (rows.length === 0) {
      throw notFound('Your bank record is missing. Contact support.');
    }
    return rows[0];
  };

  router.get('/profile', async (req, res, next) => {
    try {
      const bank = await ownBank(req);
      res.json({
        bank: presentBank(bank, { detailed: true }),
        // Restated on every response rather than only at signup, because the
        // thing a bank most needs to know is why its reservations keep failing.
        canSupply: Boolean(bank.verified_at),
        notice: bank.verified_at
          ? undefined
          : 'Your bank is listed but not verified. A coordinator must record its licence before it can supply blood.',
        disclaimer: requiredDisclaimer(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/stock', async (req, res, next) => {
    try {
      const bank = await ownBank(req);
      const rows = await db.query(
        'SELECT blood_group, units, updated_at FROM inventory WHERE bank_id = $1 ORDER BY blood_group',
        [bank.id],
      );
      res.json({
        bankId: bank.id,
        stock: rows.map((r) => ({
          bloodGroup: r.blood_group,
          units: Number(r.units),
          updatedAt: r.updated_at,
        })),
        canSupply: Boolean(bank.verified_at),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Record stock.
   *
   * An unverified bank is allowed to do this. Entering what you hold is not a
   * supply claim, and refusing it would leave a bank with no way to show a
   * coordinator what it has while it waits to be verified.
   *
   * The upsert cannot go negative because the column carries CHECK (units >= 0),
   * so a bad count is refused by the database rather than by this handler.
   */
  router.put('/stock', validate(schemas.setStock), async (req, res, next) => {
    try {
      const bank = await ownBank(req);
      assertCan(req.user, 'inventory:write:own', { bankId: bank.id });

      const { bloodGroup, units } = req.body;

      const rows = await db.query(
        `INSERT INTO inventory (bank_id, blood_group, units, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (bank_id, blood_group)
         DO UPDATE SET units = EXCLUDED.units, updated_at = now()
         RETURNING blood_group, units, updated_at`,
        [bank.id, bloodGroup, units],
      );

      res.json({
        stock: { bloodGroup: rows[0].blood_group, units: Number(rows[0].units), updatedAt: rows[0].updated_at },
        // Set to zero deliberately, as distinct from "no idea". Worth saying,
        // because an empty shelf that reads as unknown is how a patient is sent
        // to a bank that does not have the blood.
        recordedAsZero: units === 0,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Requests this bank could actually fulfil.
   *
   * Filtered by compatibility and by what is on the shelf, so a bank opens its
   * dashboard to a short list rather than a city wide firehose. That is the
   * difference between a tool somebody uses and a tool somebody mutes.
   */
  router.get('/requests', async (req, res, next) => {
    try {
      const bank = await ownBank(req);

      if (!bank.verified_at) {
        res.json({
          requests: [],
          count: 0,
          notice: 'Your bank is not verified yet, so it is not shown open requests.',
        });
        return;
      }

      const stock = await db.query(
        'SELECT blood_group, units FROM inventory WHERE bank_id = $1 AND units > 0',
        [bank.id],
      );

      const groups = stock.map((s) => s.blood_group);
      if (groups.length === 0) {
        res.json({ requests: [], count: 0, notice: 'No stock recorded yet.' });
        return;
      }

      const rows = await db.query(
        `SELECT * FROM requests
          WHERE status = 'open' AND blood_group = ANY($1)
          ORDER BY
            CASE urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
            created_at ASC
          LIMIT 50`,
        [groups],
      );

      // A bank can hold a group but not enough of it for a request asking for
      // four. Those are noise unless flagged, so they come back separately
      // rather than being mixed in or dropped.
      const fulfilable = [];
      const partial = [];
      for (const row of rows) {
        const available = stock.find((s) => s.blood_group === row.blood_group)?.units ?? 0;
        (available >= Number(row.units) ? fulfilable : partial).push({ row, available });
      }

      res.json({
        requests: presentRequestList(
          fulfilable.map((f) => f.row),
          { viewer: req.user, viewerRole: 'bank' },
        ),
        partial: presentRequestList(
          partial.map((p) => p.row),
          { viewer: null, viewerRole: null },
        ).map((r, i) => ({ ...r, unitsAvailable: Number(partial[i].available) })),
        note: 'partial means your stock covers part of the request, not all of it.',
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Take stock for a request.
   *
   * This is the one route in the system that moves blood, so it is the one that
   * leans hardest on things other than itself: reserveStock refuses an
   * unverified bank, locks the inventory row, and is stopped by a CHECK
   * constraint if the arithmetic is ever wrong.
   */
  router.post('/requests/:id/reserve', validateParams(schemas.requestId), async (req, res, next) => {
    try {
      const bank = await ownBank(req);
      assertCan(req.user, 'inventory:reserve:own', { bankId: bank.id });

      const request = await db.query('SELECT * FROM requests WHERE id = $1', [req.params.id]);
      if (request.length === 0) {
        next(notFound('No such request.'));
        return;
      }

      // A bank can only supply from the group it actually holds. Compatibility
      // is not the question here, since a group's own stock is always
      // compatible with a request for that same group, so what matters is
      // whether the shelf has anything on it. Without this the caller gets a raw
      // constraint error from deep inside the transaction.
      const shelf = await db.query(
        'SELECT units FROM inventory WHERE bank_id = $1 AND blood_group = $2',
        [bank.id, request[0].blood_group],
      );
      if (shelf.length === 0 || Number(shelf[0].units) < Number(request[0].units)) {
        next(
          badRequest('This bank does not hold enough of that group to cover the request.', {
            code: 'insufficient_on_shelf',
            available: shelf.length === 0 ? 0 : Number(shelf[0].units),
            requested: Number(request[0].units),
          }),
        );
        return;
      }

      const held = await reserveStock(db, {
        bankId: bank.id,
        requestId: request[0].id,
        bloodGroup: request[0].blood_group,
        units: request[0].units,
        now: new Date(),
      });

      res.json({
        reservation: {
          id: held.reservationId,
          units: held.units,
          expiresAt: held.expiresAt,
          unitsLeftOnShelf: held.inventoryAfter,
        },
        // Stated so nobody mistakes a hold for a transfusion. The hold expires
        // and the units go back on the shelf; nothing has been given to anyone.
        notice: `Held until ${new Date(held.expiresAt).toISOString()}. A hold is not a transfusion.`,
        disclaimer: requiredDisclaimer(),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
