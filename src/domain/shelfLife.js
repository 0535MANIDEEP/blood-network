import { REGULATORY_POLICY } from '../policy/regulatory.js';

/**
 * Component shelf life.
 *
 * My first version used a single 35 day default for everything. That is right for
 * whole blood and wrong for every other component: platelets last about a week,
 * frozen components about a year. Getting this wrong in either direction matters,
 * because too short discards usable blood and too long risks transfusing a unit
 * that should have been discarded.
 *
 * Values live in the regulatory policy file and are UNVERIFIED.
 */

const COMPONENTS = REGULATORY_POLICY.components;

export const KNOWN_COMPONENTS = Object.freeze(Object.keys(COMPONENTS));

export function isKnownComponent(component) {
  return Object.prototype.hasOwnProperty.call(COMPONENTS, component);
}

export function shelfLifeDays(component) {
  const spec = COMPONENTS[component];
  // Fail safe: an unknown component has no known safe life, so treat it as
  // expiring immediately rather than assuming it is fresh.
  return spec ? spec.days : 0;
}

export function storageRequirement(component) {
  const spec = COMPONENTS[component];
  return spec ? `${spec.storage}, ${spec.tempC} C` : 'unknown component, do not issue';
}

/**
 * Whether a unit collected on `collectedAt` is still usable.
 *
 * Fails closed on an unknown component or an unreadable date, because "I do not
 * know how old this is" is not the same as "this is fine".
 */
export function isUnitUsable(component, collectedAt, now = new Date()) {
  const days = shelfLifeDays(component);
  if (days <= 0) return false;

  const collected = new Date(collectedAt).getTime();
  if (!Number.isFinite(collected)) return false;

  return collected + days * 86_400_000 > now.getTime();
}

export function daysUntilExpiry(component, collectedAt, now = new Date()) {
  const days = shelfLifeDays(component);
  const collected = new Date(collectedAt).getTime();
  if (!Number.isFinite(collected)) return null;
  return Math.floor((collected + days * 86_400_000 - now.getTime()) / 86_400_000);
}

/**
 * FEFO, First Expiry First Out.
 *
 * A blood bank must issue the unit that expires soonest, not the oldest or the
 * closest. Issuing a 40 day unit while a 2 day unit sits on the shelf is how
 * usable blood gets wasted.
 *
 * @param {Array} units  [{ id, component, collectedAt, units }]
 * @returns {Array} the same units, soonest expiry first
 */
export function orderFEFO(units, now = new Date()) {
  if (!Array.isArray(units)) return [];
  return [...units]
    .filter((u) => u && typeof u === 'object')
    .map((u) => ({ ...u, _expiresIn: daysUntilExpiry(u.component, u.collectedAt, now) }))
    .sort((a, b) => {
      // Expired and unknown-expiry units go to the bottom, never the top. A unit
      // that is already past its date has the most negative remaining life, so a
      // plain ascending sort would otherwise put dead stock first.
      const aDead = a._expiresIn === null || a._expiresIn < 0;
      const bDead = b._expiresIn === null || b._expiresIn < 0;
      if (aDead !== bDead) return aDead ? 1 : -1;
      if (aDead && bDead) return 0;

      const aExp = a._expiresIn;
      const bExp = b._expiresIn;
      return aExp - bExp;
    })
    .map(({ _expiresIn, ...rest }) => rest);
}

/** Units expiring within `withinDays`, for the "use these first" prompt. */
export function expiringSoon(units, withinDays = 7, now = new Date()) {
  return orderFEFO(units, now).filter((u) => {
    const days = daysUntilExpiry(u.component, u.collectedAt, now);
    return days !== null && days >= 0 && days <= withinDays;
  });
}
