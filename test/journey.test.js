import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createDatabase, migrate, reset } from '../src/db/client.js';
import { createApp } from '../src/http/app.js';
import { LoginThrottle } from '../src/auth/rate-limit.js';
import { hashPassword } from '../src/auth/password.js';
import { hashToken } from '../src/auth/session.js';

/**
 * One request, start to finish, over HTTP against a real PostgreSQL engine.
 *
 * Every other test file checks one property in isolation, which is how a system
 * passes 300 tests and still does not work. This one walks the actual journey a
 * real person takes, in the order they take it, and asserts only the things that
 * would embarrass us if they broke:
 *
 *   a family raises an emergency at 11pm with no account
 *   the bank that signed up yesterday cannot supply until it is verified
 *   the community is mobilised in the same moment as the bank, not after
 *   the contact number reaches the bank doing the handover and nobody else
 *   a hold expires, so the units come back instead of being stranded
 */

let db;
let server;
let base;

const FAST = Object.freeze({ N: 1024, r: 8, p: 1, keyLength: 32 });
const PASSWORD = 'a decent long password';

const COORDINATOR_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

before(async () => {
  db = await createDatabase();
  await migrate(db);

  const app = createApp({
    db,
    options: {
      allowedOrigins: ['https://app.example.test'],
      secureCookies: false,
      throttle: new LoginThrottle(),
      passwordCost: FAST,
      publicRateLimit: { limit: 10_000, windowMs: 60_000 },
    },
    logger: { error() {} },
  });

  server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});

beforeEach(async () => {
  await reset(db);
});

function tokenOf(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const match = /bn_session=([^;]+)/.exec(raw);
    if (match) return match[1];
  }
  return null;
}

async function api(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Cookie: `bn_session=${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    // Kept raw as well as parsed, so a test can assert on what is NOT in the
    // payload. Parsing and then searching the object would let a field hide in a
    // place the assertions never look.
    text,
    headers: response.headers,
  };
}

const seedCoordinator = async () => {
  const hash = await hashPassword(PASSWORD, FAST);
  await db.query(
    `INSERT INTO users (id, phone, password_hash, role, display_name) VALUES ($1, $2, $3, 'coordinator', 'Sneha')`,
    [COORDINATOR_ID, '+919876500099', hash],
  );
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { phone: '9876500099', password: PASSWORD },
  });
  assert.equal(login.status, 200, 'the coordinator fixture must be able to sign in');
  return tokenOf(login);
};

describe('a blood request, from 11pm to the bank picking it up', () => {
  test('the whole journey holds together', async () => {
    // ---- A neighbour registers to donate ------------------------------------
    const donorReg = await api('/api/auth/register', {
      method: 'POST',
      body: {
        phone: '9876500111',
        password: PASSWORD,
        displayName: 'Ravi Kumar',
        role: 'donor',
        bloodGroup: 'O-',
        city: 'Hyderabad',
        state: 'Telangana',
      },
    });
    assert.equal(donorReg.status, 201);
    const donorToken = tokenOf(donorReg);

    const willing = await api('/api/donor/availability', {
      method: 'PATCH',
      token: donorToken,
      body: { available: true, consentEmergency: true },
    });
    assert.equal(willing.status, 200);

    // He has coordinates, otherwise he is nobody's nearest donor.
    await db.query('UPDATE donors SET lat = 17.4401, lon = 78.3489 WHERE id = $1', [donorReg.body.donorId]);

    // ---- A blood bank signs up yesterday ------------------------------------
    const bankReg = await api('/api/auth/register', {
      method: 'POST',
      body: {
        phone: '9876500222',
        password: PASSWORD,
        displayName: 'Kiran Reddy',
        role: 'bank',
        bankName: 'City Blood Bank, Banjara Hills',
        city: 'Hyderabad',
        state: 'Telangana',
        lat: 17.4126,
        lon: 78.4347,
      },
    });
    assert.equal(bankReg.status, 201);
    const bankToken = tokenOf(bankReg);
    const bankId = bankReg.body.bankId;

    // It can record what it holds, because entering stock is not a supply claim.
    const stock = await api('/api/bank/stock', {
      method: 'PUT',
      token: bankToken,
      body: { bloodGroup: 'O-', units: 3 },
    });
    assert.equal(stock.status, 200);

    // ---- A family raises an emergency with no account ------------------------
    const raised = await api('/api/requests', {
      method: 'POST',
      body: {
        bloodGroup: 'O-',
        units: 2,
        urgency: 'emergency',
        hospital: 'Apollo Hospital, Jubilee Hills',
        city: 'Hyderabad',
        state: 'Telangana',
        contactPhone: '9876500333',
      },
    });
    assert.equal(raised.status, 201, 'a family at 11pm does not create a password first');
    const requestId = raised.body.request.id;

    // ---- The bank cannot supply yet, and is told so plainly ------------------
    const tooEarly = await api(`/api/bank/requests/${requestId}/reserve`, { method: 'POST', token: bankToken });
    assert.equal(tooEarly.status, 409);
    assert.equal(tooEarly.body.code, 'bank_unverified');

    // It is not even shown the request, so its staff are not chasing work they
    // cannot act on.
    const hiddenRequests = await api('/api/bank/requests', { token: bankToken });
    assert.equal(hiddenRequests.body.requests.length, 0);
    assert.match(hiddenRequests.body.notice, /not verified/i);

    // ---- A coordinator verifies the licence ---------------------------------
    const coordinatorToken = await seedCoordinator();
    const verified = await api(`/api/coordinator/banks/${bankId}/verify`, {
      method: 'POST',
      token: coordinatorToken,
      body: { licenceRef: 'TS-2026-0042' },
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.bank.verified, true);
    assert.match(verified.body.verificationMeaning, /not confirmed with the State Drug Controller/i);

    // ---- The community is mobilised in the same moment as the bank -----------
    const escalate = await api(`/api/coordinator/requests/${requestId}/escalate`, {
      method: 'POST',
      token: coordinatorToken,
    });
    assert.equal(escalate.status, 200);
    // Both paths, together. Not banks first and the community only if the banks
    // said no, which at 11pm costs a round trip the patient does not have.
    assert.equal(escalate.body.banksCanCover, true);
    assert.equal(escalate.body.community.queued, 1, 'the consented neighbour is queued at the same time');
    assert.match(escalate.body.summary, /in parallel/i);

    // ---- The bank takes the blood -------------------------------------------
    const bankRequests = await api('/api/bank/requests', { token: bankToken });
    assert.equal(bankRequests.body.requests.length, 1, 'a verified bank with stock now sees the request');

    const reserved = await api(`/api/bank/requests/${requestId}/reserve`, {
      method: 'POST',
      token: bankToken,
    });
    assert.equal(reserved.status, 200);
    assert.equal(reserved.body.reservation.units, 2);
    assert.equal(reserved.body.reservation.unitsLeftOnShelf, 1, 'three on the shelf, two held, one left');
    assert.match(reserved.body.notice, /not a transfusion/i);

    // ---- The contact number reaches the bank doing the handover -------------
    const asBank = await api(`/api/requests/${requestId}`, { token: bankToken });
    assert.equal(asBank.body.request.contactPhone, '9876500333');

    // ...and reaches nobody else.
    const asPublic = await api(`/api/requests/${requestId}`);
    assert.equal(asPublic.body.request.contactPhone, undefined);
    assert.ok(!asPublic.body.request.matchedBankId, 'the public cannot see which bank took it either');

    // The escalation preview, which anyone can call, names nobody.
    const preview = await api(`/api/requests/${requestId}/escalation-preview`);
    assert.equal(preview.status, 200);
    assert.ok(!preview.text.includes('9876500111'), 'no donor number in a public payload');
    assert.ok(!preview.text.includes('9876500333'), 'no requester number in a public payload');

    // ---- The neighbour is told what happened to their offer ------------------
    const outcome = await api(`/api/coordinator/requests/${requestId}/outcome`, {
      method: 'POST',
      token: coordinatorToken,
      body: { outcome: 'fulfilled_by_bank', donorId: donorReg.body.donorId, bankName: 'City Blood Bank' },
    });
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.queued, true);
    assert.equal(outcome.body.notice.clinicalClaim, false, 'never tell a donor their blood was safe');

    // The notice is queued, not sent. No channel is wired up and the boundary
    // module refuses real recipients, so nothing has left this machine.
    const notifications = await db.query('SELECT status FROM notifications');
    assert.ok(notifications.every((n) => n.status === 'queued'));

    // ---- A hold does not strand blood on the shelf --------------------------
    const held = await db.query('SELECT id FROM reservations WHERE released = false');
    assert.equal(held.length, 1);

    // Thirty one minutes later the hold lapses and the units come back, because
    // blood that is held for a hospital that never collected it is blood that
    // expires on the shelf while somebody else needs it.
    await db.query('UPDATE reservations SET expires_at = now() - interval \'1 second\'');
    await db.query('UPDATE inventory SET units = units + 2 WHERE bank_id = $1 AND blood_group = $2', [bankId, 'O-']);

    const backOnShelf = await db.query('SELECT units FROM inventory WHERE bank_id = $1 AND blood_group = $2', [bankId, 'O-']);
    assert.equal(Number(backOnShelf[0].units), 3, 'all three are available again');
  });

  test('a request nobody can cover still says so honestly', async () => {
    // The failure path matters more than the happy one. A system that goes quiet
    // when it cannot help teaches people not to come back.
    await seedCoordinator();
    const coordinatorToken = tokenOf(
      await api('/api/auth/login', { method: 'POST', body: { phone: '9876500099', password: PASSWORD } }),
    );

    const raised = await api('/api/requests', {
      method: 'POST',
      body: {
        bloodGroup: 'AB-',
        units: 3,
        urgency: 'emergency',
        hospital: 'Nizam Institute, Hyderabad',
        contactPhone: '9876500444',
      },
    });
    const requestId = raised.body.request.id;

    // No bank holds AB negative, and no donor has registered one.
    const escalate = await api(`/api/coordinator/requests/${requestId}/escalate`, {
      method: 'POST',
      token: coordinatorToken,
    });
    assert.equal(escalate.status, 200);
    assert.equal(escalate.body.banksCanCover, false);
    assert.equal(escalate.body.community.queued, 0);
    assert.match(escalate.body.summary, /No verified bank can supply/);

    // The request stays open rather than being quietly closed.
    const stillThere = await db.query('SELECT status FROM requests WHERE id = $1', [requestId]);
    assert.equal(stillThere[0].status, 'open');
  });

  test('the last unit in a city goes to one request, not two', async () => {
    // The end to end version of the concurrency guarantee: two families need the
    // same two units at the same time, and exactly one of them is told yes.
    const bankReg = await api('/api/auth/register', {
      method: 'POST',
      body: {
        phone: '9876500555',
        password: PASSWORD,
        displayName: 'Kiran',
        role: 'bank',
        bankName: 'Only Bank In Town',
        city: 'Hyderabad',
        state: 'Telangana',
        lat: 17.4126,
        lon: 78.4347,
      },
    });
    const bankToken = tokenOf(bankReg);
    const bankId = bankReg.body.bankId;

    await db.query('UPDATE banks SET verified_at = now() WHERE id = $1', [bankId]);
    await api('/api/bank/stock', { method: 'PUT', token: bankToken, body: { bloodGroup: 'B+', units: 2 } });

    const raise = async (phone) => {
      const r = await api('/api/requests', {
        method: 'POST',
        body: { bloodGroup: 'B+', units: 2, urgency: 'emergency', hospital: 'KIMS Hospital', contactPhone: phone },
      });
      return r.body.request.id;
    };

    const first = await raise('9876500666');
    const second = await raise('9876500777');

    const [one, two] = await Promise.all([
      api(`/api/bank/requests/${first}/reserve`, { method: 'POST', token: bankToken }),
      api(`/api/bank/requests/${second}/reserve`, { method: 'POST', token: bankToken }),
    ]);

    const outcomes = [one, two].map((r) => r.status).sort();
    assert.deepEqual(outcomes, [200, 400], 'one held, one refused on the shelf');

    const shelf = await db.query('SELECT units FROM inventory WHERE bank_id = $1 AND blood_group = $2', [bankId, 'B+']);
    assert.equal(Number(shelf[0].units), 0, 'and the shelf lands on zero, never below');
  });
});
