/**
 * REGULATORY CONFIGURATION — THE SINGLE SOURCE OF TRUTH
 * ====================================================
 *
 *  !!  NOT VERIFIED.  !!
 *
 * Every value below is from training data, not from a primary source. The
 * National Blood Transfusion Council site, the MeitY DPDP pages and general web
 * search were all unreachable while this was written, so none of it could be
 * confirmed against the gazette, the NBTC guidelines or the Drugs and Cosmetics
 * Rules.
 *
 * This file is deliberately shaped so that nobody can ship it by accident:
 *
 *   1. Every rule carries `source`, naming the instrument it is believed to come
 *      from, and `verified: false` until a qualified reviewer confirms it.
 *   2. `assertPolicyReviewed()` throws unless a human has explicitly signed off.
 *      The server refuses to start in production with this policy unreviewed.
 *   3. Where a value is unknown, the evaluation logic fails SAFE. An unknown
 *      criterion defers a donor. It never permits one.
 *
 * A qualified reviewer (transfusion medicine specialist, or counsel with the
 * Drugs and Cosmetics Rules) should correct this file and flip the flags. That is
 * the whole point of putting it in one place.
 *
 * Sources believed to apply, all UNCONFIRMED:
 *   - Drugs and Cosmetics Act 1940, and Drugs and Cosmetics Rules 1945
 *   - NBTC National Blood Policy / donor selection and deferral guidelines
 *   - DPDP Act 2023, for consent, purpose limitation and erasure
 *   - Note: 2023 amendment rules for FSSAI were seen but not applicable to
 *     human blood; confirm with a reviewer.
 */

/** Frozen so a running process cannot have its policy mutated underneath it. */
export const REGULATORY_POLICY = Object.freeze({
  reviewed: false,
  reviewedBy: null,
  reviewedAt: null,

  sources: Object.freeze({
    primary: 'Drugs and Cosmetics Act 1940 and Rules 1945 (UNCONFIRMED)',
    donorCriteria: 'NBTC donor selection and deferral guidelines (UNCONFIRMED)',
    dataProtection: 'DPDP Act 2023 (UNCONFIRMED)',
  }),

  donor: Object.freeze({
    // Source: NBTC donor criteria, unconfirmed.
    minAgeYears: 18,
    maxAgeYears: 65,
    // A first-time donor is commonly held to the lower bound only.
    maxAgeYearsFirstDonation: 60,
    minWeightKg: 50,

    // Haemoglobin in g/dL. Unconfirmed, and the usual published values differ by
    // sex, so both are kept rather than averaged.
    haemoglobin: Object.freeze({
      male: 13.0,
      female: 12.5,
      // An unknown reading must not be treated as a pass.
      unknownIsAcceptable: false,
    }),

    vitalSigns: Object.freeze({
      pulseMin: 60,
      pulseMax: 100,
      systolicMin: 90,
      systolicMax: 140,
      diastolicMin: 60,
      diastolicMax: 90,
      temperatureMaxC: 37.5,
    }),

    // Minimum gap between donations, in days. Commonly published as 3 months for
    // male to male and 4 months where a female donor gives, but this varies.
    // Unconfirmed.
    deferralDays: Object.freeze({
      maleToMale: 90,
      maleToFemale: 120,
      femaleToMale: 120,
      femaleToFemale: 90,
    }),

    // Self-declaration triggers. Each becomes a question, not an automatic
    // rejection, except where marked `disqualifying`.
    selfDeclaration: Object.freeze({
      feverLastWeeks: 4,
      antibioticsLastDays: 7,
      tattooOrAcupunctureLastMonths: 6,
      surgeryLastMonths: 6,
      pregnancy: { applies: 'female', monthsAfterBirth: 12 },
      // Permanent. A history of any of these is a permanent deferral.
      permanentDeferral: Object.freeze([
        'hiv',
        'hepatitis_b',
        'hepatitis_c',
        'heart_disease',
        'cancer',
        'epilepsy',
        'insulin_treated_diabetes',
      ]),
    }),

    // Payment for donation is prohibited. This is not a tunable value; it is a
    // design constraint, and no code path may offer money, reimbursement or a
    // reward for donating.
    paymentProhibited: true,
  }),

  /**
   * Every donated unit must be screened before transfusion for HIV 1 and 2,
   * HBsAg, HCV and syphilis, and the donor must not be told which of those tests
   * applied to an individual donation. This app is a directory and notification
   * layer. It performs no screening and must never present a unit as safe.
   */
  screening: Object.freeze({
    requiredTests: Object.freeze(['hiv_1_2', 'hbsag', 'hcv', 'syphilis']),
    appPerformsScreening: false,
    appMayDeclareUnitSafe: false,
  }),

  /**
   * Component shelf life, which depends on storage temperature and is not one
   * number. My earlier blanket 35 day default was wrong for everything except
   * red cells. Unconfirmed.
   */
  components: Object.freeze({
    packed_red_cells: Object.freeze({ tempC: '2 to 6', days: 42, storage: 'refrigerated' }),
    whole_blood: Object.freeze({ tempC: '2 to 6', days: 35, storage: 'refrigerated' }),
    platelets: Object.freeze({ tempC: '20 to 24', days: 7, storage: 'room temperature, agitated' }),
    fresh_frozen_plasma: Object.freeze({ tempC: '-18 to -30', days: 365, storage: 'frozen' }),
    cryoprecipitate: Object.freeze({ tempC: '-18 to -30', days: 365, storage: 'frozen' }),
  }),

  consent: Object.freeze({
    // DPDP Act 2023, unconfirmed. Consent is per purpose and revocable, never a
    // single blanket boolean, and never pre-ticked.
    requiredPurposes: Object.freeze([
      'emergency_contact_matching',
      'availability_notifications',
      'non_emergency_notifications',
    ]),
    revocable: true,
    erasureConflictsWithRecordKeeping: true,
  }),
});

/**
 * Call once at startup. Refuses to run in production against an unreviewed
 * policy, so an unverified rule set cannot quietly reach a real patient.
 */
export function assertPolicyReviewed({ isProduction }) {
  if (REGULATORY_POLICY.reviewed) return;

  const message =
    'Regulatory policy is unreviewed. Values are from training data and were ' +
    'not confirmed against the Drugs and Cosmetics Rules or NBTC guidelines. ' +
    'A qualified reviewer must correct src/policy/regulatory.js and set ' +
    'reviewed = true before this handles real patient data.';

  if (isProduction) {
    throw new Error(message);
  }
  // Non-production runs, but says so loudly on every boot.
  console.warn(`[policy] WARNING: ${message}`);
}

/** Days before a donor of this profile may give again. */
export function deferralDaysFor(donorSex, previousDonorSex) {
  const d = REGULATORY_POLICY.donor.deferralDays;
  if (donorSex === 'female' || previousDonorSex === 'female') {
    return donorSex === 'female' && previousDonorSex === 'female' ? d.femaleToFemale : d.femaleToMale;
  }
  return previousDonorSex === 'female' ? d.maleToFemale : d.maleToMale;
}
