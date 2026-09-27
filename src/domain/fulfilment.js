import { canDonate, rankDonorGroup, normaliseGroup } from './compatibility.js';

/**
 * Decides which banks can fulfil which requests.
 *
 * This is pure: no database, no clock, no network. Everything it needs is passed in.
 * That is deliberate, because this is the decision that determines whether a patient
 * gets blood, and it has to be testable without standing up Postgres.
 *
 * It plans only. It never mutates stock. Reservation is a separate, transactional step,
 * so a planner bug can never oversell anything.
 */

/** Haversine distance in km, or null when either position is unknown. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => typeof v !== 'number' || Number.isNaN(v))) {
    return null;
  }
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Banks that hold enough compatible stock for a request, best candidate first.
 *
 * Ordering, in priority order:
 *   1. Urgency of the request, so emergencies are routed first.
 *   2. Whether the bank stocks the exact requested group, over a universal group.
 *      A bank holding O negative is useful, but a bank holding the exact group is a
 *      better match and should not be passed over.
 *   3. Distance, nearest first. Blood that has to travel further is more likely to
 *      be unusable by the time it arrives.
 *
 * Banks with an unknown location sort after every bank with a known location rather
 * than being treated as nearest.
 *
 * @param {object} request  { bloodGroup, units, urgency, lat, lon }
 * @param {Array}  banks    [{ id, name, lat, lon, verifiedAt, stock: { 'O-': 3 } }]
 * @param {object} options  { requireVerified, maxDistanceKm }
 */
export function planFulfilment(request, banks, options = {}) {
  const { requireVerified = true, maxDistanceKm = Infinity } = options;

  // Defensive: this is called straight off a request body, so a malformed
  // request must produce an empty plan, never a thrown error.
  if (!request || typeof request !== 'object' || !Array.isArray(banks)) return [];

  const wanted = normaliseGroup(request.bloodGroup);
  const needed = Number(request.units) || 0;
  if (!wanted || needed < 1) return [];

  const candidates = [];

  for (const bank of banks) {
    if (!bank || typeof bank !== 'object') continue;
    if (requireVerified && !bank.verifiedAt) continue;

    // A bank qualifies on any group it holds that can serve the recipient.
    const usable = Object.entries(bank.stock || {}).filter(
      ([group, units]) => canDonate(group, wanted) && units > 0,
    );
    if (usable.length === 0) continue;

    const totalUsable = usable.reduce((sum, [, units]) => sum + units, 0);
    if (totalUsable < needed) continue;

    const km = distanceKm(bank.lat, bank.lon, request.lat, request.lon);
    if (km !== null && km > maxDistanceKm) continue;

    // Best group this bank holds for this request.
    const bestGroup = usable
      .map(([group]) => group)
      .sort((a, b) => rankDonorGroup(a, wanted) - rankDonorGroup(b, wanted))[0];

    candidates.push({
      bankId: bank.id,
      bankName: bank.name,
      group: bestGroup,
      availableUnits: usable.reduce((sum, [group, units]) => sum + (group === bestGroup ? units : 0), 0),
      totalUsableUnits: totalUsable,
      distanceKm: km,
      exactGroup: normaliseGroup(bestGroup) === wanted,
    });
  }

  // Urgency is a property of the request, not a key between candidates, so it
  // plays no part here. It decides which request is routed first, not which
  // bank is best for this one.
  candidates.sort((a, b) => {
    if (a.exactGroup !== b.exactGroup) return a.exactGroup ? -1 : 1;
    const aKm = a.distanceKm ?? Number.MAX_SAFE_INTEGER;
    const bKm = b.distanceKm ?? Number.MAX_SAFE_INTEGER;
    if (aKm !== bKm) return aKm - bKm;
    return b.totalUsableUnits - a.totalUsableUnits;
  });

  return candidates;
}

/**
 * Donors who can serve a request, nearest first.
 *
 * Donors are notified, not allocated. A donor giving blood is a clinical act performed
 * at a licensed facility, so this only ranks who to tell.
 */
export function planDonorNotifications(request, donors, options = {}) {
  const { maxDistanceKm = Infinity, includeUnavailable = false } = options;
  if (!request || typeof request !== 'object' || !Array.isArray(donors)) return [];
  const wanted = normaliseGroup(request.bloodGroup);

  const matches = donors
    .filter((d) => d && typeof d === 'object')
    .filter((d) => (includeUnavailable ? true : d.available))
    .filter((d) => canDonate(d.bloodGroup, wanted))
    .map((d) => {
      const km = distanceKm(d.lat, d.lon, request.lat, request.lon);
      return { donor: d, distanceKm: km, exactGroup: normaliseGroup(d.bloodGroup) === wanted };
    })
    .filter((m) => m.distanceKm === null || m.distanceKm <= maxDistanceKm);

  matches.sort((a, b) => {
    const aKm = a.distanceKm ?? Number.MAX_SAFE_INTEGER;
    const bKm = b.distanceKm ?? Number.MAX_SAFE_INTEGER;
    if (aKm !== bKm) return aKm - bKm;
    if (a.exactGroup !== b.exactGroup) return a.exactGroup ? -1 : 1;
    return 0;
  });

  return matches;
}
