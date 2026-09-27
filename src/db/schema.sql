-- Blood Network schema.
--
-- Design rule: inventory can never go negative, and reserving the last unit has to be
-- safe under concurrency. Both are enforced by the database, not by application code,
-- because application code is the thing that gets deployed wrong.

CREATE TABLE IF NOT EXISTS banks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  city          TEXT        NOT NULL,
  state         TEXT        NOT NULL,
  -- Licence issued by the State Drug Controller. Recorded, not verified by us.
  licence_ref   TEXT,
  phone         TEXT,
  -- A bank's location is what makes "nearest bank with stock" mean anything.
  -- Without it the fulfilment planner has nothing to sort by and every bank
  -- ranks as equally distant, which silently turns proximity matching off.
  lat           DOUBLE PRECISION,
  lon           DOUBLE PRECISION,
  verified_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS banks_state_idx ON banks (state);
CREATE INDEX IF NOT EXISTS banks_city_idx  ON banks (city);

CREATE TABLE IF NOT EXISTS donors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  phone         TEXT        NOT NULL,
  blood_group   TEXT        NOT NULL CHECK (blood_group IN
                  ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  city          TEXT        NOT NULL DEFAULT '',
  state         TEXT        NOT NULL DEFAULT '',
  lat           DOUBLE PRECISION,
  lon           DOUBLE PRECISION,
  available     BOOLEAN     NOT NULL DEFAULT false,
  -- Recorded by the blood bank at the point of collection, never self declared.
  -- Sex and first time status are all the donation INTERVAL needs, and the
  -- interval is the only thing this project checks on its own. The full clinical
  -- screen, which needs haemoglobin, weight, pulse and blood pressure, is done
  -- in person at a licensed collection centre and is deliberately not modelled
  -- here, because a self service form asking a donor to certify their own blood
  -- results is not a screening programme.
  sex           TEXT        CHECK (sex IN ('male','female')),
  is_first_donation BOOLEAN  NOT NULL DEFAULT true,
  previous_donor_sex TEXT    CHECK (previous_donor_sex IN ('male','female')),
  -- NBTC deferral windows. Enforced in the API so a donor cannot re-register early.
  last_donated  DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS donors_group_idx    ON donors (blood_group, available);
CREATE INDEX IF NOT EXISTS donors_location_idx ON donors (lat, lon);

CREATE TABLE IF NOT EXISTS inventory (
  bank_id       UUID        NOT NULL REFERENCES banks (id) ON DELETE CASCADE,
  blood_group   TEXT        NOT NULL CHECK (blood_group IN
                  ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  units         INTEGER     NOT NULL DEFAULT 0 CHECK (units >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bank_id, blood_group)
);

CREATE TABLE IF NOT EXISTS requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blood_group   TEXT        NOT NULL CHECK (blood_group IN
                  ('A+','A-','B+','B-','AB+','AB-','O-','O+')),
  units         INTEGER     NOT NULL CHECK (units > 0),
  urgency       TEXT        NOT NULL DEFAULT 'routine'
                  CHECK (urgency IN ('routine','urgent','emergency')),
  hospital      TEXT        NOT NULL,
  city          TEXT        NOT NULL DEFAULT '',
  state         TEXT        NOT NULL DEFAULT '',
  lat           DOUBLE PRECISION,
  lon           DOUBLE PRECISION,
  contact_phone TEXT,
  -- Filled by the bank that takes it. Null while unmatched.
  matched_bank_id UUID REFERENCES banks (id) ON DELETE SET NULL,
  status        TEXT        NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','matched','fulfilled','cancelled','expired')),
  needed_by     TIMESTAMPTZ,
  created_by    UUID        REFERENCES donors (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS requests_open_idx   ON requests (status, blood_group);
CREATE INDEX IF NOT EXISTS requests_region_idx ON requests (state, city);

CREATE TABLE IF NOT EXISTS request_replies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    UUID        NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  author_role   TEXT        NOT NULL CHECK (author_role IN ('donor','bank','coordinator')),
  author_id     UUID,
  body          TEXT        NOT NULL CHECK (length(btrim(body)) > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS replies_request_idx ON request_replies (request_id, created_at);

-- A reservation holds stock for a bank for a limited time. Without the expiry a bank
-- could sit on the last unit forever and nobody else could use it.
--
-- blood_group is recorded on the reservation rather than joined in from inventory.
-- When a reservation lapses the units have to go back to the exact group row they
-- came from, and a join could be ambiguous if a bank's stock had been edited.
CREATE TABLE IF NOT EXISTS reservations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    UUID        NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  bank_id       UUID        NOT NULL REFERENCES banks (id) ON DELETE CASCADE,
  blood_group   TEXT        NOT NULL CHECK (blood_group IN
                  ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  units         INTEGER     NOT NULL CHECK (units > 0),
  expires_at    TIMESTAMPTZ NOT NULL,
  released      BOOLEAN     NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reservations_active_idx
  ON reservations (bank_id, blood_group, expires_at) WHERE released = false;

-- Consent is a separate, revocable record. Never a boolean on the user row.
CREATE TABLE IF NOT EXISTS consents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  TEXT        NOT NULL CHECK (subject_type IN ('donor','bank')),
  subject_id    UUID        NOT NULL,
  channel       TEXT        NOT NULL CHECK (channel IN ('whatsapp','telegram','sms','email')),
  purpose       TEXT        NOT NULL,
  granted       BOOLEAN     NOT NULL DEFAULT false,
  granted_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  UNIQUE (subject_type, subject_id, channel, purpose)
);

CREATE TABLE IF NOT EXISTS notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel       TEXT        NOT NULL,
  recipient     TEXT        NOT NULL,
  template      TEXT        NOT NULL,
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT        NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','sent','failed','skipped_no_consent')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Accounts.
--
-- The phone number is the identity, not an email address. In the intended
-- deployment almost every adult has one, whereas a meaningful fraction have no
-- email, and an account system that quietly requires the thing a chunk of
-- people lack will just exclude them.
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL CHECK (role IN ('donor','bank','coordinator')),
  display_name  TEXT        NOT NULL,

  -- What this account is allowed to act as. The constraint below is the point:
  -- a bank login physically cannot be attached to a donor record, so a
  -- compromised bank account cannot act as a person. Without it, one nullable
  -- column and one wrong query is a complete account takeover of a different
  -- kind.
  donor_id      UUID REFERENCES donors (id) ON DELETE SET NULL,
  bank_id       UUID REFERENCES banks (id) ON DELETE SET NULL,

  -- Set when a donor or bank record is deleted, so the account is disabled
  -- rather than left active with nothing to act as.
  disabled_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT users_subject_matches_role CHECK (
    (role = 'donor'      AND donor_id IS NOT NULL AND bank_id IS NULL) OR
    (role = 'bank'       AND bank_id  IS NOT NULL AND donor_id IS NULL) OR
    (role = 'coordinator' AND donor_id IS NULL     AND bank_id  IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS users_role_idx ON users (role) WHERE disabled_at IS NULL;

-- Sessions.
--
-- token_hash is the only copy. The plaintext token exists in the user's cookie
-- and nowhere else, so reading this table does not hand an attacker working
-- sessions.
--
-- The two expiries are separate columns rather than one computed value, so a
-- revoked session is distinguishable from an expired one and so the idle
-- window can slide without ever extending the absolute cap.
CREATE TABLE IF NOT EXISTS sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash         TEXT        NOT NULL UNIQUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  idle_expires_at    TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  user_agent         TEXT,
  source_address     TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (absolute_expires_at) WHERE revoked_at IS NULL;

-- Password reset.
--
-- One row per request, token hashed like a session token, single use. The
-- newest unused row for an account is the only one that validates, so requesting
-- a reset twice invalidates the first link rather than leaving two live ones.
CREATE TABLE IF NOT EXISTS password_resets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  source_address TEXT
);

CREATE INDEX IF NOT EXISTS resets_user_idx ON password_resets (user_id) WHERE used_at IS NULL;
