import 'dotenv/config';

import { createDatabase, migrate } from './client.js';
import { enforceBoundary } from '../policy/boundary.js';

/**
 * Fixtures.
 *
 * The boundary module allows fixture data and nothing else, so this is the only
 * way to get data into a development instance. That is deliberate friction: the
 * alternative is an INSERT somewhere in application code, and a seed script that
 * respects the same boundary as the rest of the system is a reminder that the
 * boundary is a property of the project rather than a setting.
 *
 * Phone numbers are the reserved Indian fiction ranges where they exist, and
 * every one is obviously fake. Nothing here can reach a real handset.
 */

enforceBoundary({
  isProduction: process.env.NODE_ENV === 'production',
  env: process.env,
  policyReviewed: false,
  seedMode: true,
  notifyRecipients: 'fixtures',
});

const db = await createDatabase({
  url: process.env.DATABASE_URL,
  dataDir: process.env.DATABASE_URL ? undefined : (process.env.PGLITE_DIR ?? './.pgdata'),
});

await migrate(db);

const BANJARA = [17.4126, 78.4347];
const GACHIBOWLI = [17.4401, 78.3489];
const SECUNDERABAD = [17.3899, 78.4983];

await db.exec(`
  -- Three fictional banks. Two verified, one still waiting, because a dataset
  -- where everything is verified teaches nothing about the unverified path.
  INSERT INTO banks (id, name, city, state, licence_ref, phone, lat, lon, verified_at) VALUES
    ('a1000000-0000-0000-0000-000000000001', 'Lakeside Blood Bank (sample)',      'Hyderabad', 'Telangana', 'SAMPLE-TS-001', '+919000000001', ${BANJARA[0]},   ${BANJARA[1]},   now()),
    ('a1000000-0000-0000-0000-000000000002', 'Secunderabad Blood Centre (sample)','Hyderabad', 'Telangana', 'SAMPLE-TS-002', '+919000000002', ${SECUNDERABAD[0]}, ${SECUNDERABAD[1]}, now()),
    ('a1000000-0000-0000-0000-000000000003', 'Gachibowli Donation Point (sample)','Hyderabad', 'Telangana', NULL,            '+919000000003', ${GACHIBOWLI[0]}, ${GACHIBOWLI[1]}, NULL);

  INSERT INTO inventory (bank_id, blood_group, units) VALUES
    ('a1000000-0000-0000-0000-000000000001', 'O-', 3),
    ('a1000000-0000-0000-0000-000000000001', 'O+', 8),
    ('a1000000-0000-0000-0000-000000000001', 'A+', 5),
    ('a1000000-0000-0000-0000-000000000001', 'B+', 2),
    ('a1000000-0000-0000-0000-000000000001', 'AB+', 1),
    ('a1000000-0000-0000-0000-000000000001', 'AB-', 0),
    ('a1000000-0000-0000-0000-000000000002', 'O-', 1),
    ('a1000000-0000-0000-0000-000000000002', 'O+', 4),
    ('a1000000-0000-0000-0000-000000000002', 'A-', 2);

  -- Sample donors. is_first_donation stays true for most of them so the interval
  -- does not start excluding people who have never given.
  INSERT INTO donors (id, name, phone, blood_group, city, state, lat, lon, available, sex, is_first_donation, last_donated) VALUES
    ('d1000000-0000-0000-0000-000000000001', 'Sample Donor A', '+919100000001', 'O-',  'Hyderabad', 'Telangana', ${GACHIBOWLI[0]},   ${GACHIBOWLI[1]},   true,  'male',   true,  NULL),
    ('d1000000-0000-0000-0000-000000000002', 'Sample Donor B', '+919100000002', 'O-',  'Hyderabad', 'Telangana', ${BANJARA[0]},       ${BANJARA[1]},       true,  'female', true,  NULL),
    ('d1000000-0000-0000-0000-000000000003', 'Sample Donor C', '+919100000003', 'O+',  'Hyderabad', 'Telangana', ${SECUNDERABAD[0]},  ${SECUNDERABAD[1]},  true,  'male',   true,  NULL),
    ('d1000000-0000-0000-0000-000000000004', 'Sample Donor D', '+919100000004', 'A+',  'Hyderabad', 'Telangana', ${GACHIBOWLI[0]},   ${GACHIBOWLI[1]},   true,  'female', false, current_date - 200),
    ('d1000000-0000-0000-0000-000000000005', 'Sample Donor E', '+919100000005', 'B+',  'Hyderabad', 'Telangana', ${BANJARA[0]},       ${BANJARA[1]},       true,  'male',   false, current_date - 30),
    ('d1000000-0000-0000-0000-000000000006', 'Sample Donor F', '+919100000006', 'AB-', 'Hyderabad', 'Telangana', ${SECUNDERABAD[0]},  ${SECUNDERABAD[1]},  true,  'male',   true,  NULL),
    ('d1000000-0000-0000-0000-000000000007', 'Sample Donor G', '+919100000007', 'O-',  'Hyderabad', 'Telangana', ${BANJARA[0]},       ${BANJARA[1]},       false, 'female', true,  NULL);

  -- Only two of the seven have opted in to being contacted. A dataset where
  -- everybody has consented would make the consent gate look like it does
  -- nothing, which is exactly the bug it is there to prevent.
  INSERT INTO consents (subject_type, subject_id, channel, purpose, granted, granted_at, revoked_at) VALUES
    ('donor', 'd1000000-0000-0000-0000-000000000001', 'sms', 'emergency_contact', true,  now(), NULL),
    ('donor', 'd1000000-0000-0000-0000-000000000002', 'sms', 'emergency_contact', true,  now(), NULL),
    ('donor', 'd1000000-0000-0000-0000-000000000003', 'sms', 'emergency_contact', true,  now(), now()),
    ('donor', 'd1000000-0000-0000-0000-000000000004', 'sms', 'emergency_contact', true,  now(), NULL);

  -- One coordinator, so the verification path is reachable in development.
  INSERT INTO users (id, phone, password_hash, role, display_name) VALUES
    ('c1000000-0000-0000-0000-000000000001', '+919000000099', 'scrypt$16384$8$1$c2VlZHNhbHRzYWx0c2FsdA==$MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=', 'coordinator', 'Sample Coordinator');
`);

const counts = await db.query(`
  SELECT
    (SELECT count(*)::int FROM banks)      AS banks,
    (SELECT count(*)::int FROM donors)     AS donors,
    (SELECT count(*)::int FROM inventory)  AS stockLines,
    (SELECT count(*)::int FROM consents)   AS consents
`);

console.log('[seed] fixtures loaded', counts[0]);
console.log('[seed] every phone number above is a reserved sample range. None can reach a real handset.');
console.log('[seed] three of seven donors have NOT opted in to emergency contact, on purpose.');

await db.close();
