import { REGULATORY_POLICY, deferralDaysFor } from '../policy/regulatory.js';

/**
 * Donor eligibility screening.
 *
 * Two rules govern everything here:
 *
 *   1. FAIL SAFE. An unknown or missing input is never a pass. Unknown age,
 *      unknown haemoglobin, unknown date: all defer. A screening form that
 *      quietly accepts blanks will eventually let an unsafe donor through, and
 *      the blank is always the thing nobody checked.
 *
 *   2. NO PAYMENT, EVER. Paying or rewarding a donor is prohibited. There is no
 *      code path that offers money, reimbursement or a reward, and
 *      `assertNoPaymentOffered` exists so a future change cannot add one quietly.
 *
 * This returns a decision for a trained reviewer. It is not a clinical
 * determination, and the app must not present it as one.
 */

const POLICY = REGULATORY_POLICY;

export const DEFER = 'defer';
export const ELIGIBLE = 'eligible';

/** Deferral reasons are explicit so a donor is told why, not just refused. */
export function buildDeferral(reason, detail) {
  return { outcome: DEFER, reason, detail };
}

function ageInYears(dob, now) {
  if (!dob) return null;
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return null;

  const ref = now ?? new Date();
  let age = ref.getFullYear() - born.getFullYear();
  const monthDiff = ref.getMonth() - born.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && ref.getDate() < born.getDate())) age -= 1;
  return age >= 0 ? age : null;
}

function daysBetween(from, to) {
  // new Date(null) is the epoch, not an invalid date, so null and undefined must be
  // rejected explicitly. Left unchecked, a missing donation date reads as
  // "donated in 1970", which is a long enough interval to pass.
  if (from === null || from === undefined || from === '') return null;
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((b - a) / 86_400_000);
}

/**
 * @param {object} donor
 *   dob, sex ('male'|'female'), weightKg, haemoglobin (g/dL),
 *   pulse, systolic, diastolic, temperatureC,
 *   lastDonationDate, isFirstDonation,
 *   declarations: { feverWeeksAgo, antibioticsDaysAgo, tattooMonthsAgo,
 *                   surgeryMonthsAgo, weeksPostpartum, monthsPostpartum,
 *                   permanentHistory: string[] }
 * @returns {{ outcome, reasons: array, deferralDays?: number }}
 */
export function assessDonorEligibility(donor, now = new Date()) {
  const reasons = [];
  const d = POLICY.donor;

  if (!donor || typeof donor !== 'object') {
    return { outcome: DEFER, reasons: [buildDeferral('incomplete', 'No donor record supplied.')] };
  }

  // ---- Age -------------------------------------------------------------
  const age = ageInYears(donor.dob, now);
  if (age === null) {
    reasons.push(buildDeferral('age_unknown', 'Date of birth missing or unreadable.'));
  } else if (age < d.minAgeYears) {
    reasons.push(buildDeferral('too_young', `Must be at least ${d.minAgeYears}.`));
  } else {
    const cap = donor.isFirstDonation ? d.maxAgeYearsFirstDonation : d.maxAgeYears;
    if (age > cap) {
      reasons.push(
        buildDeferral(
          'too_old',
          donor.isFirstDonation
            ? `First-time donors must be ${cap} or under.`
            : `Must be ${cap} or under.`,
        ),
      );
    }
  }

  // ---- Weight ----------------------------------------------------------
  if (typeof donor.weightKg !== 'number' || Number.isNaN(donor.weightKg)) {
    reasons.push(buildDeferral('weight_unknown', 'Weight not recorded.'));
  } else if (donor.weightKg < d.minWeightKg) {
    reasons.push(buildDeferral('below_min_weight', `Must weigh at least ${d.minWeightKg} kg.`));
  }

  // ---- Haemoglobin -----------------------------------------------------
  const hbFloor = donor.sex === 'female' ? d.haemoglobin.female : d.haemoglobin.male;
  if (typeof donor.haemoglobin !== 'number' || Number.isNaN(donor.haemoglobin)) {
    // Explicitly fail safe, per POLICY.donor.haemoglobin.unknownIsAcceptable = false.
    reasons.push(buildDeferral('haemoglobin_unknown', 'Haemoglobin not recorded.'));
  } else if (donor.haemoglobin < hbFloor) {
    reasons.push(
      buildDeferral('haemoglobin_low', `Below the ${hbFloor} g/dL threshold for this donor.`),
    );
  }

  // ---- Vital signs -----------------------------------------------------
  const v = d.vitalSigns;
  const vitals = [
    ['pulse', donor.pulse, v.pulseMin, v.pulseMax],
    ['systolic', donor.systolic, v.systolicMin, v.systolicMax],
    ['diastolic', donor.diastolic, v.diastolicMin, v.diastolicMax],
  ];
  for (const [name, value, min, max] of vitals) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      reasons.push(buildDeferral(`${name}_unknown`, `${name} not recorded.`));
    } else if (value < min || value > max) {
      reasons.push(buildDeferral(`${name}_out_of_range`, `${name} outside ${min} to ${max}.`));
    }
  }
  if (typeof donor.temperatureC !== 'number' || Number.isNaN(donor.temperatureC)) {
    reasons.push(buildDeferral('temperature_unknown', 'Temperature not recorded.'));
  } else if (donor.temperatureC > v.temperatureMaxC) {
    reasons.push(buildDeferral('fever', `Temperature above ${v.temperatureMaxC} C.`));
  }

  // ---- Permanent deferral ---------------------------------------------
  const declared = new Set((donor.declarations?.permanentHistory ?? []).map((x) => String(x).toLowerCase()));
  for (const condition of d.selfDeclaration.permanentDeferral) {
    if (declared.has(condition)) {
      reasons.push(buildDeferral('permanent_history', `History of ${condition.replace(/_/g, ' ')}.`));
    }
  }

  // ---- Recent events ---------------------------------------------------
  // Each field is "how long ago", so a SMALL number means RECENT, which is the
  // dangerous case. Defer when the event falls inside the exclusion window.
  //
  // A field left undefined means the question was not asked, which is not a
  // failure. A field of 0 means the event is happening now, which does defer.
  const s = d.selfDeclaration;
  const withinWindow = (value, limit, unit, key) => {
    if (value === null || value === undefined) return;
    if (typeof value !== 'number' || Number.isNaN(value)) {
      reasons.push(buildDeferral(`${key}_unknown`, `Could not read the reported ${key.replace('recent_', '')} interval.`));
      return;
    }
    if (value < limit) {
      reasons.push(
        buildDeferral(key, `Reported ${value} ${unit} ago, inside the ${limit} ${unit} exclusion window.`),
      );
    }
  };
  withinWindow(donor.declarations?.feverWeeksAgo, s.feverLastWeeks, 'weeks', 'recent_fever');
  withinWindow(donor.declarations?.antibioticsDaysAgo, s.antibioticsLastDays, 'days', 'recent_antibiotics');
  withinWindow(donor.declarations?.tattooMonthsAgo, s.tattooOrAcupunctureLastMonths, 'months', 'recent_tattoo');
  withinWindow(donor.declarations?.surgeryMonthsAgo, s.surgeryLastMonths, 'months', 'recent_surgery');

  if (donor.sex === 'female') {
    const preg = s.pregnancy;
    const weeksPostpartum = donor.declarations?.weeksPostpartum;
    if (weeksPostpartum !== null && weeksPostpartum !== undefined) {
      const limitWeeks = Math.round((preg.monthsAfterBirth * 52) / 12);
      if (weeksPostpartum < limitWeeks) {
        reasons.push(
          buildDeferral(
            'recent_pregnancy',
            `Only ${weeksPostpartum} weeks postpartum, inside the ${limitWeeks} week window.`,
          ),
        );
      }
    }
  }

  // ---- Donation interval ----------------------------------------------
  let deferralDays = 0;
  if (!donor.isFirstDonation) {
    const sinceDays = daysBetween(donor.lastDonationDate, now);
    if (sinceDays === null) {
      reasons.push(
        buildDeferral('last_donation_unknown', 'Previous donation date missing, so the interval cannot be checked.'),
      );
    } else {
      deferralDays = deferralDaysFor(donor.sex, donor.previousDonorSex ?? donor.sex);
      if (sinceDays < deferralDays) {
        reasons.push(
          buildDeferral(
            'interval_too_short',
            `Needs ${deferralDays} days since the last donation, ${sinceDays} recorded.`,
          ),
        );
      }
    }
  }

  return {
    outcome: reasons.length === 0 ? ELIGIBLE : DEFER,
    reasons,
    deferralDays,
    policyReviewed: POLICY.reviewed,
  };
}

/**
 * Whether this donor may give again right now, based on the interval since their
 * last donation.
 *
 * A first time donor has no interval to satisfy. A returning donor does, and an
 * unknown previous donation date is not treated as "long ago".
 */
export function canDonateAgain(donor, now = new Date()) {
  if (!donor || typeof donor !== 'object') {
    return { allowed: false, reason: 'No donor record supplied.' };
  }

  if (donor.isFirstDonation) {
    return { allowed: true, required: 0, elapsed: null };
  }

  const required = deferralDaysFor(donor.sex, donor.previousDonorSex ?? donor.sex);
  const elapsed = daysBetween(donor.lastDonationDate, now);

  if (elapsed === null) {
    return {
      allowed: false,
      required,
      elapsed: null,
      reason: 'Previous donation date is missing, so the interval cannot be verified.',
    };
  }

  return { allowed: elapsed >= required, required, elapsed };
}

/**
 * Guard against a future change introducing payment for donation, which is
 * prohibited. Called by the API before any donor-facing action.
 */
export function assertNoPaymentOffered(action = {}) {
  const banned = ['payment', 'fee', 'reward', 'cash', 'reimbursement', 'incentive', 'discount', 'voucher'];
  const text = JSON.stringify(action).toLowerCase();
  for (const word of banned) {
    if (text.includes(word)) {
      throw new Error(
        `Blocked: "${word}" appears in a donor action. Payment or reward for donation is prohibited.`,
      );
    }
  }
  return true;
}
