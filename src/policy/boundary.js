/**
 * PROJECT BOUNDARY
 * ================
 *
 * This is a student engineering project. It demonstrates how donor matching,
 * inventory and notification logic work. It is not a blood bank, not a medical
 * device, and not a transfusion service.
 *
 * The boundary is enforced here rather than left to good intentions, because an
 * intention erodes the first time something is genuinely urgent. Any change that
 * pushes this project toward operating a real service will hit an assertion
 * instead of shipping quietly.
 *
 * What that means concretely, and why each one matters:
 *
 *  1. NO REAL PATIENT DATA. A service holding real patient records is a regulated
 *     activity. A project seeded with synthetic records is not. The distinction is
 *     the data, not the intent.
 *
 *  2. NO REAL BLOOD BANKS. Accepting a genuine licensed bank supplying genuine
 *     stock turns a directory into a supply chain. Banks are seeded fixtures only.
 *
 *  3. NO NOTIFICATIONS TO REAL PEOPLE. A broadcast that reaches actual phones
 *     during a real emergency makes people act on our output. Test numbers only.
 *
 *  4. NO MONEY, EVER. Payment for donation is prohibited in India regardless of
 *     how the project is framed. See assertNoPaymentOffered.
 *
 *  5. NO CLINICAL CLAIMS. The words "safe", "approved", "sterile" and
 *     "transfusion ready" are not ours to assert. We rank compatibility; a
 *     licensed clinician and a licensed bank decide transfusions.
 *
 * Setting ALLOW_REAL_DATA is deliberately awkward: it needs an explicit
 * environment variable AND a signed off policy review, so it cannot be flipped by
 * accident, by a stray commit, or by a well-meaning contributor.
 */

const ALLOW_ENV = 'ALLOW_REAL_DATA';

/** Reasons a deployment is refused, in the order they are checked. */
export const BLOCKERS = Object.freeze({
  REAL_PATIENT_DATA: 'real_patient_data',
  REAL_BANK_SUPPLY: 'real_bank_supply',
  REAL_NOTIFICATIONS: 'real_notifications',
  UNREVIEWED_POLICY: 'unreviewed_regulatory_policy',
});

export const BOUNDARY_STATEMENT =
  'Student engineering project. Not a blood bank, not a medical device, and not a ' +
  'substitute for a licensed blood bank or a clinician. Demonstrates donor matching, ' +
  'inventory and notification logic using synthetic data only. No real patient is ' +
  'transfused on the basis of this software.';

/** Banned outside quotations. These are the words that turn a demo into a claim. */
const FORBIDDEN_CLAIMS = [
  'safe',
  'sterile',
  'approved for transfusion',
  'transfusion ready',
  'transfusion-ready',
  'clinically proven',
  'medically certified',
  'guaranteed',
  'cure',
  'lifesaving',
];

/**
 * @param {object} options
 *   isProduction, env, policyReviewed, seedMode, notifyRecipients
 */
export function assertWithinBoundary(options = {}) {
  const {
    isProduction = false,
    env = {},
    policyReviewed = false,
    seedMode = true,
    notifyRecipients = 'fixtures',
  } = options;

  const override = String(env[ALLOW_ENV] ?? '').toLowerCase() === 'true';

  // The override is not a bypass. It only unlocks a deployment that ALSO has a
  // reviewed policy, so it can never be the thing that carries a real deployment.
  if (override && !policyReviewed) {
    throw new Error(
      `${ALLOW_ENV} is set but the regulatory policy is unreviewed. Both are required, ` +
        'and neither is something a student project should satisfy.',
    );
  }

  if (override) {
    return { withinBoundary: false, override: true, blockers: [] };
  }

  const blockers = [];

  if (!seedMode) {
    blockers.push({
      code: BLOCKERS.REAL_PATIENT_DATA,
      detail: 'Real patient records cannot be loaded into a student project.',
    });
  }

  if (env.BANK_SUPPLY_MODE && env.BANK_SUPPLY_MODE !== 'fixtures') {
    blockers.push({
      code: BLOCKERS.REAL_BANK_SUPPLY,
      detail: 'Only seeded fixture banks may supply stock.',
    });
  }

  if (notifyRecipients && notifyRecipients !== 'fixtures' && notifyRecipients !== 'none') {
    blockers.push({
      code: BLOCKERS.REAL_NOTIFICATIONS,
      detail: 'Notifications may only go to fixture recipients, never to real phones.',
    });
  }

  if (isProduction && !policyReviewed) {
    blockers.push({
      code: BLOCKERS.UNREVIEWED_POLICY,
      detail: 'A public deployment needs a reviewed regulatory policy.',
    });
  }

  return { withinBoundary: blockers.length === 0, override: false, blockers };
}

/** Throwing form, for use at startup and in request middleware. */
export function enforceBoundary(options) {
  const result = assertWithinBoundary(options);
  if (!result.withinBoundary) {
    const summary = result.blockers.map((b) => `${b.code}: ${b.detail}`).join(' | ');
    throw new Error(`Project boundary violated. ${summary}`);
  }
  return result;
}

/**
 * Fails closed on clinical language. Marketing copy reaches a real reader, and a
 * demo that says "transfusion ready" will eventually be read by someone in an
 * emergency who believes it.
 */
export function assertNoClinicalClaim(text) {
  if (typeof text !== 'string') return true;
  const lower = text.toLowerCase();
  for (const phrase of FORBIDDEN_CLAIMS) {
    if (lower.includes(phrase)) {
      throw new Error(
        `Blocked clinical claim: "${phrase}". This project ranks compatibility, it does ` +
          'not certify blood. A licensed clinician and a licensed bank decide transfusions.',
      );
    }
  }
  return true;
}

/** Every user-facing surface must carry this. Cheap, and it cannot be forgotten. */
export function requiredDisclaimer() {
  return BOUNDARY_STATEMENT;
}
