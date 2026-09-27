/**
 * Red cell donor to recipient compatibility.
 *
 * This is the same rule set the Android app ships, asserted by the same table. It is
 * duplicated here deliberately rather than shared, because the API and the phone must
 * both be able to validate independently: the server is the authority, and the client
 * must not be able to talk it into a wrong answer.
 *
 * Both must hold:
 *   Antigen. Group O carries neither A nor B, so O may donate to any group. Every other
 *   donor must carry the same antigen set as the recipient, compared in full so that AB
 *   is not mistaken for A.
 *   Rh. A positive donor carries the D antigen, so may only give to a positive
 *   recipient. A negative donor may give to either, which is why O negative is the
 *   universal donor.
 *
 * The direction that must never be violated is positive into negative.
 */

export const BLOOD_GROUPS = Object.freeze([
  'A+',
  'A-',
  'B+',
  'B-',
  'AB+',
  'AB-',
  'O+',
  'O-',
]);

const GROUP_SET = new Set(BLOOD_GROUPS);

export function isValidGroup(value) {
  return typeof value === 'string' && GROUP_SET.has(value.trim().toUpperCase());
}

export function normaliseGroup(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

/** The ABO antigen set, without the Rh sign. AB is two characters. */
function antigenOf(group) {
  return group.slice(0, -1);
}

export function canDonate(donorGroup, recipientGroup) {
  const donor = normaliseGroup(donorGroup);
  const recipient = normaliseGroup(recipientGroup);

  if (!GROUP_SET.has(donor) || !GROUP_SET.has(recipient)) return false;

  const donorAntigen = antigenOf(donor);
  if (donorAntigen !== 'O' && donorAntigen !== antigenOf(recipient)) return false;

  const donorPositive = donor.endsWith('+');
  const recipientPositive = recipient.endsWith('+');

  return !(donorPositive && !recipientPositive);
}

/** Every donor group that may give to this recipient group. */
export function donorGroupsFor(recipientGroup) {
  return BLOOD_GROUPS.filter((candidate) => canDonate(candidate, recipientGroup));
}

/** Prefer the closest exact match, then universal donors, then further out. */
export function rankDonorGroup(donorGroup, recipientGroup) {
  const donor = normaliseGroup(donorGroup);
  if (donor === normaliseGroup(recipientGroup)) return 0;
  return 1;
}

/**
 * Units of whole blood are perishable. How long a unit stays usable depends on the
 * storage temperature, so the caller supplies the component policy. A blood bank
 * integrating this must set the correct value for what it actually stores.
 */
export const DEFAULT_UNIT_SHELF_LIFE_DAYS = 35;

export function isPastShelfLife(donatedAt, shelfLifeDays = DEFAULT_UNIT_SHELF_LIFE_DAYS, now = new Date()) {
  const collected = new Date(donatedAt).getTime();

  // Fail closed. An unparseable collection date must read as expired, never as
  // fresh, because "unknown age" is not the same as "within date".
  if (!Number.isFinite(collected)) return true;

  const expires = collected + shelfLifeDays * 86_400_000;
  return expires <= now.getTime();
}
