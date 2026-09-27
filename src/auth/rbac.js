/**
 * Access control.
 *
 * Two independent checks, and the second one is the one that actually matters:
 *
 *   1. Role. Is a coordinator allowed to verify a bank at all?
 *   2. Scope. Is THIS bank allowed to change THIS bank's stock?
 *
 * A role check on its own is the classic mistake. Every bank user has the
 * "bank" role, so "banks may edit inventory" is true and also tells you nothing.
 * The rule that protects one hospital's stock from another is ownership, and it
 * has to be checked separately every time.
 *
 * All three roles are checked against a single table, so the whole policy is
 * readable in one place and testable as a whole.
 */

export const ROLES = Object.freeze(['donor', 'bank', 'coordinator']);

/**
 * What each role may do, regardless of which record they own.
 *
 * The `*` value for bank and donor rows is deliberately absent. There is no
 * permission here that lets a donor or bank row act on every record of that
 * kind; where that is wanted it is a coordinator action.
 */
const PERMISSIONS = Object.freeze({
  donor: Object.freeze([
    'request:raise',
    'request:view',
    'request:reply',
    'donor:availability:own',
    'donor:profile:own',
    'notification:preferences:own',
  ]),
  bank: Object.freeze([
    'request:raise',
    'request:view',
    'request:reply',
    'inventory:read:own',
    'inventory:write:own',
    'inventory:reserve:own',
    'bank:profile:own',
    'notification:preferences:own',
  ]),
  coordinator: Object.freeze([
    'request:raise',
    'request:view',
    'request:reply',
    'request:assign',
    'request:cancel:any',
    'request:escalate',
    'bank:verify',
    'bank:profile:any',
    'donor:verify:any',
    'notification:broadcast',
    'notification:preferences:any',
    'user:disable',
    'reports:view',
  ]),
});

/**
 * Permission names carry their scope in the suffix, so a granted permission
 * cannot be checked against the wrong object. `:own` means the caller's linked
 * record, `:any` means anything, and a permission with no suffix is a global
 * capability.
 */
export const SCOPES = Object.freeze({ OWN: 'own', ANY: 'any', GLOBAL: 'global' });

export class ForbiddenError extends Error {
  constructor(permission, reason = 'role_not_permitted') {
    super(`Not permitted: ${permission} (${reason})`);
    this.name = 'ForbiddenError';
    this.permission = permission;
    this.reason = reason;
  }
}

export class UnauthenticatedError extends Error {
  constructor() {
    super('Authentication required.');
    this.name = 'UnauthenticatedError';
  }
}

export function permissionsFor(role) {
  return PERMISSIONS[role] ?? [];
}

export function roleHas(role, permission) {
  return permissionsFor(role).includes(permission);
}

/**
 * The record a user acts for, derived from their role.
 *
 * Accepts both shapes deliberately. A raw database row carries bank_id or
 * donor_id; the authenticated principal that travels with a request carries
 * subjectId, because that is the only field toPublicUser exposes. Both are
 * server derived, so honouring either does not widen who a caller may act as.
 *
 * Supporting only the row shape is a bug that fails closed rather than open,
 * which is the safe direction but still a bug: a bank that cannot pass its own
 * ownership check cannot read its own stock, and the symptom is a 403 that reads
 * like a permissions problem rather than a shape mismatch.
 */
export function subjectIdFor(user) {
  if (!user) return null;

  if (user.subjectId !== undefined && user.subjectId !== null) {
    return user.subjectId;
  }
  if (user.role === 'donor') return user.donor_id ?? null;
  if (user.role === 'bank') return user.bank_id ?? null;
  return null;
}

/**
 * Can this user perform this permission on this resource?
 *
 * @param user    { id, role, donor_id, bank_id }
 * @param permission  e.g. 'inventory:write:own'
 * @param resource    optional { bankId, donorId, ownerId } for the ownership check
 */
export function can(user, permission, resource = {}) {
  if (!user || !user.role) return false;
  if (!roleHas(user.role, permission)) return false;

  const scope = permission.split(':').pop();
  if (scope !== SCOPES.OWN) return true;

  const own = subjectIdFor(user);
  if (own === null) return false; // a coordinator has no subject to own

  const target = resource.bankId ?? resource.donorId ?? resource.ownerId ?? null;
  if (target === null) return false; // asking about "own" with no target is not a pass

  return String(own) === String(target);
}

/**
 * Assert, for callers that would rather branch than inspect a boolean.
 */
export function assertCan(user, permission, resource = {}) {
  if (!user) throw new UnauthenticatedError();
  if (can(user, permission, resource)) return true;

  // The two failure dimensions are reported separately. can() returns false for
  // both, so asking it again would only ever say role_not_permitted and lose
  // the distinction between "your job does not allow this" and "this is not
  // your record", which are different problems with different fixes.
  throw new ForbiddenError(permission, roleHas(user.role, permission) ? 'not_your_record' : 'role_not_permitted');
}

/**
 * Whether a caller may see a given donor's contact details.
 *
 * Separate from the permission table because it is not a capability, it is a
 * disclosure decision, and it depends on who is asking and why. A donor's phone
 * number is how a community finds them, so it is not private in the way a
 * password is, but it is still not broadcast to anyone who asks.
 */
export function canSeeDonorContact({ actor, donorId, reason }) {
  if (!actor) return { allowed: false, reason: 'not_authenticated' };

  if (actor.role === 'coordinator') return { allowed: true, reason: 'coordinator' };

  if (actor.role === 'bank') {
    return reason === 'matched_donor'
      ? { allowed: true, reason: 'bank_matching_this_request' }
      : { allowed: false, reason: 'bank_sees_only_matched_donors' };
  }

  if (actor.role === 'donor') {
    return String(subjectIdFor(actor)) === String(donorId)
      ? { allowed: true, reason: 'own_record' }
      : { allowed: false, reason: 'donors_see_only_themselves' };
  }

  return { allowed: false, reason: 'unknown_role' };
}
