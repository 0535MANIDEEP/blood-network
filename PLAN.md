# PLAN — Blood Network v2

## Finish line

A working system, not a prototype. A donor registers once and is reachable. A licensed
blood bank publishes stock. A coordinator raises a request against real inventory. The
system matches compatible donors, routes the request to banks that can fulfil it, and
notifies people who opted in, through a channel that works. A wrong match is impossible,
not merely unlikely.

Every claim on the portfolio is a link to something that runs.

## Status: in progress

## Architecture

```
blood-network/          backend, the system of record
  src/
    db/                 schema, migrations, transactions
    auth/               sessions, RBAC
    routes/             REST API
    realtime/           WebSocket gateway
    notify/             channel adapters (whatsapp, telegram, sms)
  test/
blood-bank-android/     Android client, offline-first
dashboard/              blood bank and coordinator web UI
download-site/          public download page, linked from portfolio
```

### Stack, and why

| Layer | Choice | Reason |
|---|---|---|
| Database | PostgreSQL | Inventory decrement needs a transaction. Overselling the last unit is a safety failure, not a bug. |
| API | Node + Express | One language across API and dashboard. |
| Auth | Session cookie + RBAC | Three roles, three different UIs. |
| Realtime | WebSocket | "Realtime" has to actually be realtime. |
| Mobile | Java + XML + SQLite | Native Android. SQLite is the offline cache, not the source of truth. |
| Dashboard | React | Blood bank and coordinator are desktop users. |

SQLite stays in the app as an **offline cache and write-ahead queue**, so a donor in a
basement hospital with no signal can still register and queue a request.

## Roles

| Role | Can do |
|---|---|
| `donor` | Register, set availability, see nearby requests they match, respond |
| `bank` | Manage own stock, fulfil requests routed to the bank, see its own history |
| `coordinator` | Raise requests, see everything, reassign, export |

## Compliance posture

This is a **directory and notification layer over licensed blood banks**. It does not
perform transfusion and does not decide who transfuses into whom. That boundary is the
single most important design decision in the project.

Required before launch, and **not yet verified**:
- Drugs and Cosmetics Act 1940 and Rules 1945
- NBTC national blood policy and donor eligibility criteria
- DPDP Act 2023 consent and purpose limitation
- Telemedicine Practice Guidelines 2020, only if a clinician is ever in the loop

These are from training data, not confirmed against source. **They must be checked with
a lawyer or the NBTC before this handles real patient data.** No clinical claim appears
anywhere in the product until that is done.

## Non-negotiables

1. **Inventory is never negative.** Enforced by a transaction and a database constraint.
2. **Compatibility is one implementation**, shared by the API, the app and the tests. It
   is never re-derived.
3. **Every unit is a scarce, expiring resource.** Reservations have a TTL and expire.
4. **Consent is explicit, revocable, and recorded.** No pre-ticked boxes.
5. **No clinical claims.** The app routes and notifies. It does not diagnose.

## Steps

### B — Backend foundation
- [ ] B1 Postgres schema: donors, banks, inventory, requests, request_replies, reservations, notifications, consent
- [ ] B2 Transactional stock decrement with a `CHECK (units >= 0)` constraint
- [ ] B3 Compatibility module, ported from the tested Android implementation, single source
- [ ] B4 Auth: register, login, session cookie, role middleware
- [ ] B5 Donor routes: register, availability, nearby matching requests
- [ ] B6 Bank routes: stock CRUD, fulfil, reservation TTL
- [ ] B7 Coordinator routes: raise request, list, reassign, export
- [ ] B8 Request thread: replies, read state
- [ ] B9 Realtime gateway, per request room
- [ ] B10 Notification adapter interface + WhatsApp deep link + Telegram
- [ ] B11 Tests: compatibility, transaction rollback, RBAC, reservation expiry

### A — Android client
- [ ] A1 Offline-first sync layer, SQLite as cache with a write-ahead queue
- [ ] A2 Role-based navigation
- [ ] A3 Donor: register, availability, matched requests, respond
- [ ] A4 Bank: stock, incoming requests, fulfil
- [ ] A5 Coordinator: raise request, monitor, reassign
- [ ] A6 Request thread UI with realtime updates
- [ ] A7 Notifications adapter on the client
- [ ] A8 Permissions: exactly location, documented in-app

### D — Dashboard
- [ ] D1 Bank console
- [ ] D2 Coordinator console

### W — Download site (only after Manideep approves the app)
- [ ] W1 Public download page
- [ ] W2 Link from portfolio
- [ ] W3 GitHub profile evidence

## Blockers

| Blocker | Needed for | Effect today |
|---|---|---|
| Supabase or Postgres credentials | Any central data | App still runs fully offline |
| Android release keystore | Play Store | APK is debug-signed, sideload only |
| Legal review of the four instruments | Real patient data | App runs on sample data only |
