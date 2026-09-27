# Blood Network

A directory and notification layer over licensed blood banks. It answers two
questions when someone needs blood: which nearby bank actually has it, and which
nearby people could donate it. It does not perform, certify or facilitate a
transfusion.

**This is a student engineering project.** It is not a blood bank, not a medical
device, and not a substitute for a licensed blood bank or a clinician. It runs on
synthetic fixtures only. No real patient is transfused on the basis of this
software.

---

## What it is not, stated up front

Most of the risk in a project like this is somebody reading the README and
believing more than is there. So:

| It does not | Because |
| --- | --- |
| Certify blood as safe, sterile or transfusion ready | Those words are not ours to assert. A licensed clinician and a licensed bank decide transfusions. The words are actively blocked in code, at `src/policy/boundary.js`, and any outbound message containing one fails to send. |
| Confirm a bank's licence | `banks.verified_at` records that a **human coordinator looked up a licence reference**. It was not confirmed with the State Drug Controller, because this project has no way to do that and the field would be a lie. |
| Replace donor screening | The donation **interval** is checked, which is date arithmetic. Haemoglobin, weight, pulse, blood pressure and medical history are screened **in person at a licensed collection centre**. A self-service form asking a donor to certify their own blood results is not a screening programme, so this project does not have one. |
| Match a donor directly to a patient | The scope is a directory of banks plus a community notification layer. A donor is **notified**, never allocated. Giving blood is a clinical act performed at a licensed facility. |
| Take money | Payment for donation is prohibited in India regardless of framing. `assertNoPaymentOffered` exists in the domain layer. |

## The regulatory policy is unreviewed, and that is a blocker

`src/policy/regulatory.js` holds every deferral interval, age bound, weight
minimum, haemoglobin threshold and vital sign range. **Those values came from
training data. They were not confirmed against the Drugs and Cosmetics Rules or
NBTC guidelines.** The file says `reviewed: false`, and:

- `assertPolicyReviewed({ isProduction: true })` **throws**, refusing to boot.
- `enforceBoundary()` refuses a production deployment.

A transfusion medicine specialist or a lawyer has to review that file and set
`reviewed = true` before this handles real data. Until then it is a working
system with unreviewed constants in it, and the code says so rather than
pretending otherwise.

## What is actually verified

328 tests across 75 suites, run against a **real PostgreSQL engine**, not a mock.

The test suite uses [PGlite](https://pglite.dev), which is PostgreSQL 18.3
compiled to WebAssembly and running in process. That matters more than it sounds:
the central safety claim of this project is that inventory can never go negative,
and that claim lives in a `CHECK` constraint and a row lock. A mock would have
proven nothing about either.

| Property | How it is proven |
| --- | --- |
| Inventory cannot go negative | A `CHECK (units >= 0)` column constraint, tested against the real engine, plus a refused reservation leaves stock untouched |
| A hold is all or nothing | A failure part way through a transaction rolls back the decrement and leaves no reservation row |
| Abandoned holds do not strand blood | Expired reservations are swept inside the next reservation's transaction, before the stock figure is read |
| One hospital cannot touch another's stock | Ownership is checked separately from role, on every bank route |
| A signup cannot make a bank supplyable | `banks.verified_at` stays null and `reserveStock` refuses, covered by a test that signs a bank up, tries to reserve, and is rejected |
| A donor who opted out is not messaged | Consent is re-checked **at send time**, not at queue time, so opting out while a message is queued still works |
| Nobody can read a requester's phone number | The public projection omits the field entirely. Asserted against the raw response text, not the parsed object |
| Internal errors do not leak | A deliberately broken database, asserting no credentials, hostnames or driver detail in the 500 |

### One claim that is deliberately not made

The row lock (`SELECT ... FOR UPDATE`) serialises concurrent reservations for the
same bank and group. PGlite is a single connection, so the test suite **cannot**
produce genuine write contention and does not pretend to. The suite drives
contention sequentially, which does prove the invariant that matters (no sequence
of callers can take more units than exist). Verifying the lock's benefit under
true parallelism needs a pooled PostgreSQL, and `test/inventory.db.test.js` says
so in a comment rather than leaving a misleading green tick.

## Running it

Requires Node 20 or newer. No database installation, no Docker, no API keys.

```bash
npm install
npm test          # 328 tests against a real PostgreSQL engine, in process
npm run seed      # fictional banks, donors and stock
npm start         # http://localhost:4000
```

The database defaults to a local PGlite directory. Point `DATABASE_URL` at a real
PostgreSQL server and the same code runs on a pooled connection, no code changes:

```bash
DATABASE_URL=postgres://user:pass@host:5432/blood npm start
```

### Try the whole thing

```bash
curl -X POST localhost:4000/api/requests \
  -H 'Content-Type: application/json' \
  -d '{"bloodGroup":"O-","units":2,"urgency":"emergency",
       "hospital":"Apollo Hospital","city":"Hyderabad","state":"Telangana",
       "contactPhone":"9876500123"}'
```

Note there is no account and no login. That is deliberate, and it is explained
below.

`GET /api/requests` lists it back, and the response contains no phone number.

## Design decisions that are not obvious

**Raising a request does not require an account.** At 11pm with a trauma patient,
putting a sign-up form between a family and the phone call that saves time is the
wrong trade, and password hashing is slow enough to be felt. So the write path is
public, rate limited, validated and capped. Notifying donors **does** require an
account and explicit consent, because that is where abuse and privacy actually
live. The emergency is not gated; the broadcast is.

**Banks and the community are mobilised at the same time.** The original design
was banks first, then notify donors only if a bank declined. At 11pm that spends a
coordinator round trip on the one resource a trauma patient does not have.
Asking the community costs nothing and runs in parallel, so it always runs.

**Notification is tiered, not broadcast.** The nearest donors are asked first and
the next tier is only widened on a deliberate human decision, because a cron job
that quietly doubles the blast radius overnight is how a donor community gets
switched off by the people it depends on.

**An offer that vanishes teaches people not to answer next time.** Every outcome,
including *"someone closer covered this one"* and *"we did not manage to cover
this, it remains open"*, is reported back to the donor.

**Availability and consent are separate switches.** "I could donate today" is not
"you may message me at 2am". Conflating them is how a donor registry becomes a
nuisance and loses its donors.

**Ownership is checked separately from role.** A role check alone cannot express
the rule that matters. Every bank user has the same role, so "banks may edit
inventory" is true of all of them and protects nothing. The check that stops one
hospital editing another's stock is "is this your bank".

**Sessions are stored only as SHA-256.** A stolen database yields hashes that
cannot be replayed as cookies. Two expiries rather than one, because a sliding
window alone can be kept alive forever by whoever stole it. A completed password
reset revokes every session, because a reset that leaves the attacker's cookie
working is not a recovery.

## Layout

```
src/
  domain/      pure logic, no I/O. compatibility, eligibility, shelf life,
               FEFO ordering, fulfilment planning, escalation
  policy/      the boundary and the unreviewed regulatory constants
  db/          schema, client (PGlite or pg), transactional inventory,
               row-to-domain mapping, fixtures
  auth/        scrypt hashing, sessions, RBAC and ownership, throttling
  http/        express app, validation, redaction, rate limiting, routes
  notify/      channel adapters and the consent-checked dispatcher
test/          328 tests, including a full end-to-end journey
```

The `db/` mapping modules exist because the domain is written in camelCase and the
database is not. Skipping them is silent: the planner reads `request.bloodGroup`,
gets `undefined` from a raw row's `blood_group`, matches nobody, and returns an
empty plan with no error. That happened, and it would have looked to a
coordinator like "no donors nearby".

## Known gaps

- **Regulatory policy unreviewed.** Blocks any real deployment. Needs a qualified
  reviewer, not more code.
- **Rate limiting is per process and in memory.** It stops casual and
  single-source automated abuse. It does not stop a distributed one, and it
  resets on restart. A multi-instance deployment needs it in Redis or Postgres.
  The limits say this in the code rather than overstating them.
- **No realtime.** Requests and offers are polled. There is no WebSocket gateway.
- **No delivery channel is configured.** Notifications are queued and dispatched
  through a webhook adapter or a deep link, but no gateway is wired up, so nothing
  has left the machine. The default channel is a dry run that sends nothing and
  leaves the queue intact.
- **Password reset has no delivery callback wired up**, so a reset cannot
  complete in this build. The token generation, single use and session revocation
  are all implemented and tested.
- **No frontend.** The API is the deliverable.

## Licence

MIT. See `LICENSE`.
