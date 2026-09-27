/**
 * Donor repository.
 *
 * One job: turn a database row into the shape the domain functions expect.
 *
 * The domain is written in camelCase and takes a plain object. The database is
 * snake_case and returns a row. Without this mapping the two never meet, and the
 * failure is quiet rather than loud: eligibility functions read
 * `donor.lastDonationDate`, get undefined from `last_donated`, and conclude the
 * donation date is unknown, which is a deferral. So a system wired up without
 * this file refuses donors who are perfectly eligible, and the bug reads as a
 * policy decision rather than a missing mapping.
 */
export function toDonorDomain(row) {
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    bloodGroup: row.blood_group,
    city: row.city,
    state: row.state,
    lat: row.lat,
    lon: row.lon,
    available: row.available,
    sex: row.sex ?? undefined,
    // The database stores a DATE, which node-postgres hands back as a Date and
    // PGlite hands back as a string depending on the column type. Normalised to
    // an ISO date string, because daysBetween parses this and a Date object
    // parses to something surprising.
    lastDonationDate: normaliseDate(row.last_donated),
    // A donor with a recorded donation date is by definition not a first time
    // donor, whatever the flag says. Derived rather than trusted, so a row that
    // was never updated after a donation still produces the right answer.
    isFirstDonation: row.last_donated ? false : (row.is_first_donation ?? true),
    previousDonorSex: row.previous_donor_sex ?? undefined,
  };
}

function normaliseDate(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const text = String(value);
  // Guard the classic trap: new Date(null) is the epoch, not "unknown", so an
  // absent date has to be caught before it reaches the parser.
  if (text === '' || text === 'Invalid Date') return null;
  return text.slice(0, 10);
}

export function toDonorDomains(rows) {
  return (rows ?? []).map(toDonorDomain);
}
