/**
 * Request row to domain shape.
 *
 * Same reason as src/db/donors.js, and the failure here is worse because it is
 * silent. The fulfilment planner reads request.bloodGroup; a raw row has
 * blood_group. So wanted comes out undefined, canDonate matches nobody, and the
 * escalation plan comes back with an empty donor list and no error at all. A
 * coordinator looking at that screen sees "no donors nearby" and concludes the
 * community is asleep, when in fact the matcher was handed a field name it does
 * not use.
 */
export function toRequestDomain(row) {
  if (!row) return null;

  return {
    id: row.id,
    bloodGroup: row.blood_group,
    units: Number(row.units),
    urgency: row.urgency,
    hospital: row.hospital,
    city: row.city,
    state: row.state,
    lat: row.lat,
    lon: row.lon,
    contactPhone: row.contact_phone,
    status: row.status,
    matchedBankId: row.matched_bank_id,
    createdBy: row.created_by,
    neededBy: row.needed_by,
    createdAt: row.created_at,
  };
}

/** The donor shape the planner expects, without the full domain mapping. */
export function toDonorPlanShape(row, { consentedEmergency = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    bloodGroup: row.blood_group,
    available: row.available,
    lat: row.lat,
    lon: row.lon,
    consented: { emergency: consentedEmergency },
  };
}

export function toBankPlanShape(row, stock = {}) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    verifiedAt: row.verified_at,
    stock,
  };
}
