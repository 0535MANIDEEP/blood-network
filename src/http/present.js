import { canSeeDonorContact } from '../auth/rbac.js';
import { requiredDisclaimer } from '../policy/boundary.js';

/**
 * What each caller is allowed to see.
 *
 * Written as one function rather than as field lists spread across routes,
 * because a request carries a contact phone number, and that number is the whole
 * reason someone might want to hit the public list endpoint. Scattered
 * projections eventually grow one that forgets to drop it, and the resulting
 * endpoint hands out a directory of people having blood transfused, tied to the
 * hospital they are in.
 *
 * The default is to withhold. Every field has to be argued for.
 */

/** Fields anyone may read. Nothing here identifies a person. */
const PUBLIC_FIELDS = ['id', 'bloodGroup', 'units', 'urgency', 'hospital', 'city', 'state', 'status', 'createdAt', 'neededBy'];

/** Redacted marker, so a client cannot mistake an absent field for a null one. */
const WITHHELD = null;

export function presentRequest(row, { viewer = null, viewerRole = null } = {}) {
  const base = {
    id: row.id,
    bloodGroup: row.blood_group,
    units: Number(row.units),
    urgency: row.urgency,
    hospital: row.hospital,
    city: row.city,
    state: row.state,
    status: row.status,
    createdAt: row.created_at,
    neededBy: row.needed_by,
  };

  // The requester's own phone number, and the bank that took it, are for the
  // people arranging the handover. Not for the public list.
  const isParticipant =
    viewerRole === 'coordinator' ||
    (viewerRole === 'bank' && row.matched_bank_id && viewer?.subjectId === row.matched_bank_id);

  const contact = canSeeDonorContact({
    actor: viewerRole ? { role: viewerRole, donor_id: viewer?.subjectId, bank_id: viewer?.subjectId } : null,
    donorId: row.created_by,
    // A bank only earns the number for a request it is actually matched to,
    // which is what the isParticipant check above already established.
    reason: isParticipant ? 'matched_donor' : 'listing',
  });

  if (isParticipant) {
    base.contactPhone = row.contact_phone ?? WITHHELD;
    base.matchedBankId = row.matched_bank_id ?? WITHHELD;
  }

  // Coordinates locate a person at a hospital. Only useful to someone arranging
  // a handover, and harmful to a passer by.
  if (isParticipant) {
    base.lat = row.lat;
    base.lon = row.lon;
  } else {
    base.approximateArea = row.city ? `${row.city}, ${row.state}`.replace(/^, |, $/g, '') : null;
  }

  base.disclaimer = requiredDisclaimer();
  return base;
}

export function presentRequestList(rows, options) {
  return rows.map((row) => presentRequest(row, options));
}

/**
 * A donor as seen by somebody else.
 *
 * Name and blood group are public, because that is how a community forms.
 * Availability, exact coordinates and donation history are not, because they
 * describe a person's medical and daily routine and nobody asked for them.
 */
export function presentDonor(donor, { detailed = false } = {}) {
  const base = {
    id: donor.id,
    name: donor.name,
    bloodGroup: donor.blood_group,
    city: donor.city,
    state: donor.state,
  };

  if (detailed) {
    base.available = donor.available;
    base.lat = donor.lat;
    base.lon = donor.lon;
    base.lastDonated = donor.last_donated;
  }

  return base;
}

export function presentBank(bank, { detailed = false } = {}) {
  const base = {
    id: bank.id,
    name: bank.name,
    city: bank.city,
    state: bank.state,
    // Verification is the single most decision relevant fact about a bank and it
    // is never hidden. A bank that cannot be checked looks exactly like one that
    // can, unless the flag is right there.
    verified: Boolean(bank.verified_at),
  };

  if (detailed) {
    base.licenceRef = bank.licence_ref ?? WITHHELD;
    base.phone = bank.phone ?? WITHHELD;
    base.verifiedAt = bank.verified_at;
  }

  return base;
}
