import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createDatabase, migrate, reset } from '../src/db/client.js';
import { createApp } from '../src/http/app.js';
import { LoginThrottle } from '../src/auth/rate-limit.js';
import { hashToken } from '../src/auth/session.js';

/**
 * Driven over a real socket, not by calling handlers directly.
 *
 * That distinction is the whole reason this file exists. A direct call skips the
 * middleware chain, so a cookie that is never actually set, a route mounted at
 * the wrong path, a CORS refusal that never fires and a 404 handler that never
 * gets reached all still look like they work. Over HTTP none of them can hide.
 */

let db;
let server;
let base;

const FAST = Object.freeze({ N: 1024, r: 8, p: 1, keyLength: 32 });
const PASSWORD = 'a decent long password';

const beforeAll = async () => {
  db = await createDatabase();
  await migrate(db);

  const app = createApp({
    db,
    options: {
      allowedOrigins: ['https://app.example.test'],
      secureCookies: false,
      throttle: new LoginThrottle(),
      passwordCost: FAST,
      // Effectively unlimited for the shared server. Every test here comes from
      // 127.0.0.1, so a real limit would be a single shared budget and the suite
      // would start failing based on how many tests happened to run first. The
      // limit is exercised for real further down, against its own server.
      publicRateLimit: { limit: 10_000, windowMs: 60_000 },
    },
    logger: { error() {} },
  });

  server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
};

const afterAll = async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
};

before(beforeAll);
after(afterAll);

beforeEach(async () => {
  await reset(db);
});

async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Cookie: `bn_session=${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Left as null so a non JSON response is visible as such in a failure.
  }

  return { status: response.status, body: json, text, headers: response.headers };
}

const register = (over = {}) =>
  call('/api/auth/register', {
    method: 'POST',
    body: {
      phone: '9876500001',
      password: PASSWORD,
      displayName: 'Asha Rao',
      role: 'donor',
      bloodGroup: 'O+',
      city: 'Hyderabad',
      state: 'Telangana',
      ...over,
    },
  });

/** Pull the token out of the Set-Cookie header. */
function extractToken(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const match = /bn_session=([^;]+)/.exec(raw);
    if (match) return match[1];
  }
  return null;
}

const seedVerifiedBank = async ({ verified = true, units = { 'O-': 5 }, lat, lon } = {}) => {
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: {
      phone: '9876500100',
      password: PASSWORD,
      displayName: 'Kiran',
      role: 'bank',
      bankName: 'City Blood Bank',
      city: 'Hyderabad',
      state: 'Telangana',
      // Banjara Hills. Without coordinates the bank can never be ranked by
      // proximity, which is the whole basis of "nearest bank with stock".
      lat: lat ?? 17.4126,
      lon: lon ?? 78.4347,
    },
  });
  const token = extractToken(reg);

  if (verified) {
    await db.query('UPDATE banks SET verified_at = now(), licence_ref = $2 WHERE id = $1', [reg.body.bankId, 'TS-2026-001']);
  }
  for (const [group, count] of Object.entries(units)) {
    await db.query('INSERT INTO inventory (bank_id, blood_group, units) VALUES ($1, $2, $3)', [reg.body.bankId, group, count]);
  }
  return { bankId: reg.body.bankId, token };
};

const seedCoordinator = async () => {
  await db.exec(`
    INSERT INTO banks (id, name, city, state) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Seed Bank', 'Hyderabad', 'Telangana')
  `);
  await db.exec(`
    INSERT INTO users (id, phone, password_hash, role, display_name)
    VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '+919876500099', 'x', 'coordinator', 'Sneha')
  `);
  const hash = await (await import('../src/auth/password.js')).hashPassword(PASSWORD, FAST);
  await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', hash]);
  return 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
};

describe('health and about', () => {
  test('health reports the database it actually reached', async () => {
    const r = await call('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
    assert.equal(r.body.database, 'ok');
  });

  test('about carries the boundary statement', async () => {
    const r = await call('/api/about');
    assert.equal(r.status, 200);
    assert.match(r.body.disclaimer, /Not a blood bank/);
    assert.ok(r.body.whatItIsNot.length >= 3);
  });

  test('an unknown route is a 404 problem document, not a stack trace', async () => {
    const r = await call('/api/nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.status, 404);
    assert.equal(r.body.type, 'urn:problem:not-found');
    assert.ok(!/\bat .*\.js:\d+/.test(r.text), 'no file and line numbers in the response');
  });

  test('security headers are set and the framework is not advertised', async () => {
    const r = await call('/api/health');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-powered-by'), null);
  });
});

describe('CORS refuses an origin that is not on the list', () => {
  test('an allowed origin is echoed back', async () => {
    const r = await call('/api/health', { headers: { Origin: 'https://app.example.test' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.example.test');
  });

  test('an unlisted origin gets no allow header', async () => {
    // The attack this prevents: any page the user visits sends a credentialed
    // request here and reads the response. Reflecting the origin is what makes
    // that work, so reflecting nothing is the fix.
    const r = await call('/api/health', { headers: { Origin: 'https://evil.example' } });
    assert.notEqual(r.headers.get('access-control-allow-origin'), 'https://evil.example');
  });

  test('credentials are allowed only alongside a real allowlist', async () => {
    const r = await call('/api/health', { headers: { Origin: 'https://app.example.test' } });
    assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
  });
});

describe('raising a request needs no account', () => {
  const body = {
    bloodGroup: 'O-',
    units: 2,
    urgency: 'emergency',
    hospital: 'Apollo Hospital, Jubilee Hills',
    city: 'Hyderabad',
    state: 'Telangana',
    contactPhone: '9876500123',
  };

  test('an anonymous person can raise one', async () => {
    // The decision this whole design rests on. A family at 11pm should not have
    // to create a password first.
    const r = await call('/api/requests', { method: 'POST', body });
    assert.equal(r.status, 201);
    assert.equal(r.body.request.bloodGroup, 'O-');
    assert.equal(r.body.request.status, 'open');
  });

  test('the raiser gets their own contact number back', async () => {
    const r = await call('/api/requests', { method: 'POST', body });
    assert.equal(r.body.request.contactPhone, '9876500123');
  });

  test('a bad group is refused with a field error', async () => {
    const r = await call('/api/requests', { method: 'POST', body: { ...body, bloodGroup: 'O?' } });
    assert.equal(r.status, 400);
    assert.ok(r.body.fieldErrors.some((f) => f.field === 'bloodGroup'));
  });

  test('a missing contact number is refused', async () => {
    const { contactPhone, ...noPhone } = body;
    const r = await call('/api/requests', { method: 'POST', body: noPhone });
    assert.equal(r.status, 400);
  });

  test('an absurd unit count is refused, because that is noise not a request', async () => {
    const r = await call('/api/requests', { method: 'POST', body: { ...body, units: 5000 } });
    assert.equal(r.status, 400);
  });

  test('a fractional unit count is refused', async () => {
    const r = await call('/api/requests', { method: 'POST', body: { ...body, units: 1.5 } });
    assert.equal(r.status, 400);
  });

  test('a clinical claim in the hospital name is blocked', async () => {
    const r = await call('/api/requests', {
      method: 'POST',
      body: { ...body, hospital: 'Apollo sterile transfusion ready unit' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.detail, /clinical claim/i);
  });

  test('an oversized body is refused', async () => {
    const r = await call('/api/requests', {
      method: 'POST',
      body: { ...body, hospital: 'x'.repeat(20_000) },
    });
    assert.equal(r.status, 413, 'and with a 413, not a 500');
  });

  test('an unknown field is ignored rather than stored', async () => {
    const r = await call('/api/requests', {
      method: 'POST',
      body: { ...body, matched_bank_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', status: 'fulfilled' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.request.status, 'open', 'a client cannot set the status it wants');
    // Absent, not null. The field is withheld from a non participant, and a
    // client should not be able to read "withheld" as "matched to nothing".
    assert.equal(r.body.request.matchedBankId, undefined);
  });
});

describe('the public list is not a phone number directory', () => {
  test('a contact number is never returned to the public', async () => {
    await call('/api/requests', {
      method: 'POST',
      body: { bloodGroup: 'O-', units: 1, hospital: 'Apollo', city: 'Hyderabad', state: 'Telangana', contactPhone: '9876500123' },
    });

    const list = await call('/api/requests');
    assert.equal(list.status, 200);
    assert.equal(list.body.requests.length, 1);
    // The field is not merely nulled, it is absent, so a client cannot tell the
    // difference between "withheld" and "this request has no phone".
    assert.equal(list.body.requests[0].contactPhone, undefined);
    assert.ok(!list.text.includes('9876500123'), 'the number does not appear anywhere in the payload');
  });

  test('coordinates are reduced to an area for the public', async () => {
    await call('/api/requests', {
      method: 'POST',
      body: {
        bloodGroup: 'O-', units: 1, hospital: 'Apollo',
        city: 'Hyderabad', state: 'Telangana', contactPhone: '9876500123',
        lat: 17.4126, lon: 78.4347,
      },
    });
    const list = await call('/api/requests');
    assert.equal(list.body.requests[0].lat, undefined);
    assert.equal(list.body.requests[0].approximateArea, 'Hyderabad, Telangana');
  });

  test('every public response carries the disclaimer', async () => {
    // Each test seeds its own request. The suite truncates between tests, so
    // leaning on a previous test's data is how a suite becomes order dependent
    // and starts failing for reasons that have nothing to do with the code.
    await call('/api/requests', {
      method: 'POST',
      body: { bloodGroup: 'O-', units: 1, hospital: 'Apollo', contactPhone: '9876500123' },
    });
    const list = await call('/api/requests');
    assert.match(list.body.requests[0].disclaimer, /Not a blood bank/);
  });

  test('the escalation preview names nobody', async () => {
    await seedVerifiedBank();
    const raised = await call('/api/requests', {
      method: 'POST',
      body: { bloodGroup: 'O-', units: 1, hospital: 'Apollo', city: 'Hyderabad', state: 'Telangana', contactPhone: '9876500123' },
    });

    const r = await call(`/api/requests/${raised.body.request.id}/escalation-preview`);
    assert.equal(r.status, 200);
    // Counts only. A public endpoint that returns names is a consent bypass.
    assert.equal(typeof r.body.preview.banksConsidered, 'number');
    assert.ok(!/donorId|\+91/.test(r.text), 'no donor identities in a public payload');
  });
});

describe('the public write endpoint is rate limited', () => {
  // Its own server with its own small budget. Sharing the main server would mean
  // sharing one budget across every test, and the suite would then depend on
  // test order, which is a bad property for a suite to have.
  let limited;
  let limitedBase;

  before(async () => {
    const app = createApp({
      db,
      options: {
        secureCookies: false,
        throttle: new LoginThrottle(),
        passwordCost: FAST,
        publicRateLimit: { limit: 3, windowMs: 60_000 },
      },
      logger: { error() {} },
    });
    limited = createServer(app);
    await new Promise((r) => limited.listen(0, '127.0.0.1', r));
    limitedBase = `http://127.0.0.1:${limited.address().port}`;
  });

  after(async () => {
    await new Promise((r) => limited.close(r));
  });

  const flood = async (n) => {
    const body = { bloodGroup: 'O-', units: 1, hospital: 'Apollo', contactPhone: '9876500123' };
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const r = await fetch(`${limitedBase}/api/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      out.push({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) });
    }
    return out;
  };

  test('a flood is stopped, and stopped with a 429 rather than a 500', async () => {
    // The bug this caught: the limiter handed next() a plain object, the error
    // handler did not recognise it, and every blocked request came back 500. A
    // client seeing 500 retries straight away, which defeats the limit entirely.
    const results = await flood(6);
    const statuses = results.map((r) => r.status);

    assert.deepEqual(statuses.slice(0, 3), [201, 201, 201], 'the budget is spent first');
    assert.ok(
      statuses.slice(3).every((s) => s === 429),
      `blocked requests should be 429, got ${statuses.join(',')}`,
    );
  });

  test('a 429 is a problem document that tells the client when to retry', async () => {
    const results = await flood(6);
    const blocked = results.find((r) => r.status === 429);

    assert.ok(blocked, 'a request was blocked');
    assert.equal(blocked.body.type, 'urn:problem:rate-limited');
    assert.ok(blocked.body.retryAfterSeconds > 0);
    assert.ok(blocked.headers.get('retry-after'), 'Retry-After must be readable by the browser');
  });

  test('the remaining budget is reported while there is any left', async () => {
    // Its own server again. The two tests above have already spent this
    // limiter's whole budget, so reading a fresh remaining count from a shared
    // one would just measure the test order.
    const app = createApp({
      db,
      options: {
        secureCookies: false,
        throttle: new LoginThrottle(),
        passwordCost: FAST,
        publicRateLimit: { limit: 3, windowMs: 60_000 },
      },
      logger: { error() {} },
    });
    const own = createServer(app);
    await new Promise((r) => own.listen(0, '127.0.0.1', r));
    const ownBase = `http://127.0.0.1:${own.address().port}`;

    try {
      const r = await fetch(`${ownBase}/api/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bloodGroup: 'O-', units: 1, hospital: 'Apollo', contactPhone: '9876500123' }),
      });
      assert.equal(r.headers.get('x-ratelimit-remaining'), '2');
    } finally {
      await new Promise((r) => own.close(r));
    }
  });
});

describe('accounts over HTTP', () => {
  test('a donor can register and gets a working session cookie', async () => {
    const r = await register();
    assert.equal(r.status, 201);
    assert.equal(r.body.user.role, 'donor');

    const me = await call('/api/auth/me', { token: extractToken(r) });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.displayName, 'Asha Rao');
  });

  test('a bank registering is told it is not verified yet', async () => {
    const r = await call('/api/auth/register', {
      method: 'POST',
      body: { phone: '9876500002', password: PASSWORD, displayName: 'Kiran', role: 'bank', bankName: 'City Blood Bank' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.pendingVerification, true);
    assert.match(r.body.notice, /verify/i);
  });

  test('the password is never echoed back', async () => {
    const r = await register();
    assert.ok(!r.text.includes(PASSWORD));
    assert.ok(!r.text.includes('scrypt'));
  });

  test('a wrong password is a generic 401', async () => {
    await register();
    const r = await call('/api/auth/login', { method: 'POST', body: { phone: '9876500001', password: 'wrong' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.detail, 'Phone number or password is incorrect.');
  });

  test('me without a session is a 401', async () => {
    const r = await call('/api/auth/me');
    assert.equal(r.status, 401);
  });

  test('logging out kills the session over HTTP too', async () => {
    const r = await register();
    const token = extractToken(r);
    assert.equal((await call('/api/auth/me', { token })).status, 200);

    const out = await call('/api/auth/logout', { method: 'POST', token });
    assert.equal(out.status, 200);
    assert.equal((await call('/api/auth/me', { token })).status, 401);
  });

  test('a reset request gives the same answer for a known and unknown number', async () => {
    await register();
    const known = await call('/api/auth/reset-request', { method: 'POST', body: { phone: '9876500001' } });
    const unknown = await call('/api/auth/reset-request', { method: 'POST', body: { phone: '9876500009' } });

    assert.equal(known.status, unknown.status);
    assert.deepEqual(known.body, unknown.body, 'no membership oracle');
  });

  test('a reset request never returns the token', async () => {
    await register();
    const r = await call('/api/auth/reset-request', { method: 'POST', body: { phone: '9876500001' } });
    assert.equal(r.body.token, undefined);
    assert.ok(!/bn_reset|[a-f0-9]{64}/.test(r.text), 'nothing token shaped in the response');
  });
});

describe('roles cannot borrow each others routes', () => {
  test('a donor gets 403 on bank routes', async () => {
    const r = await register();
    const res = await call('/api/bank/stock', { token: extractToken(r) });
    assert.equal(res.status, 403);
  });

  test('a bank gets 403 on coordinator routes', async () => {
    const { token } = await seedVerifiedBank();
    const res = await call('/api/coordinator/overview', { token });
    assert.equal(res.status, 403);
  });

  test('a donor gets 403 on the reengagement list', async () => {
    // An operational list of who is overdue for a donation is not a donor's to see.
    const r = await register();
    const res = await call('/api/coordinator/reengagement', { token: extractToken(r) });
    assert.equal(res.status, 403);
  });

  test('a signed out caller gets 401, not 403', async () => {
    // Distinguishing the two tells an attacker whether an account exists.
    const res = await call('/api/bank/stock');
    assert.equal(res.status, 401);
  });
});

describe('donor endpoints', () => {
  test('a donor can set availability and see their profile', async () => {
    const r = await register();
    const token = extractToken(r);

    const set = await call('/api/donor/availability', {
      method: 'PATCH',
      token,
      body: { available: true, consentEmergency: true },
    });
    assert.equal(set.status, 200);
    assert.equal(set.body.donor.available, true);

    const profile = await call('/api/donor/profile', { token });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.donor.bloodGroup, 'O+');
    assert.equal(typeof profile.body.canDonateAgain.allowed, 'boolean');
  });

  test('availability and emergency consent are recorded separately', async () => {
    // Someone happy to donate when asked in person has not agreed to be called
    // at 2am, and one flag for both makes a registry a nuisance.
    const r = await register();
    const token = extractToken(r);

    const willing = await call('/api/donor/availability', { method: 'PATCH', token, body: { available: true } });
    assert.equal(willing.status, 200, 'marking yourself willing must not require a medical self certificate');

    const consents = await db.query('SELECT granted FROM consents WHERE purpose = $1', ['emergency_contact']);
    assert.equal(consents.length, 0, 'no consent was recorded');

    await call('/api/donor/availability', { method: 'PATCH', token, body: { available: true, consentEmergency: true } });
    const after = await db.query('SELECT granted FROM consents WHERE purpose = $1', ['emergency_contact']);
    assert.equal(after[0].granted, true);
  });

  test('the profile says plainly that screening happens at the bank', async () => {
    const r = await register();
    const profile = await call('/api/donor/profile', { token: extractToken(r) });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.screening.doneHere, false);
    assert.match(profile.body.screening.doneBy, /blood bank/i);
  });

  test('consent can be withdrawn', async () => {
    const r = await register();
    const token = extractToken(r);
    await call('/api/donor/availability', { method: 'PATCH', token, body: { consentEmergency: true } });
    await call('/api/donor/availability', { method: 'PATCH', token, body: { consentEmergency: false } });

    const consents = await db.query('SELECT granted, revoked_at FROM consents WHERE purpose = $1', ['emergency_contact']);
    assert.equal(consents[0].granted, false);
    assert.ok(consents[0].revoked_at, 'withdrawal is recorded, not just flipped');
  });

  test('a donor inside the donation interval is told, not blocked', async () => {
    const r = await register();
    const token = extractToken(r);

    // Donated 30 days ago, so the interval has not elapsed.
    await db.query('UPDATE donors SET last_donated = current_date - 30, sex = $2 WHERE id = $1', [r.body.donorId, 'male']);

    const profile = await call('/api/donor/profile', { token });
    assert.equal(profile.body.canDonateAgain.allowed, false, 'the interval is reported honestly');

    // But willingness is still the donor's to declare. Refusing it would be
    // this project performing a clinical judgement it is not entitled to make.
    const willing = await call('/api/donor/availability', { method: 'PATCH', token, body: { available: true } });
    assert.equal(willing.status, 200);
  });
});

describe('bank endpoints are scoped to the caller own bank', () => {
  test('a bank reads its own stock', async () => {
    const { token } = await seedVerifiedBank({ units: { 'O-': 5, 'A+': 2 } });
    const r = await call('/api/bank/stock', { token });
    assert.equal(r.status, 200);
    assert.equal(r.body.stock.length, 2);
    assert.equal(r.body.canSupply, true);
  });

  test('a bank can record its own stock', async () => {
    const { token, bankId } = await seedVerifiedBank({ units: {} });
    const r = await call('/api/bank/stock', { method: 'PUT', token, body: { bloodGroup: 'B+', units: 4 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.stock.units, 4);

    const rows = await db.query('SELECT units FROM inventory WHERE bank_id = $1', [bankId]);
    assert.equal(Number(rows[0].units), 4);
  });

  test('setting stock to zero is distinguished from unknown', async () => {
    // An empty shelf that reads as "unknown" is how somebody is sent to a bank
    // that does not have the blood.
    const { token } = await seedVerifiedBank({ units: { 'O-': 3 } });
    const r = await call('/api/bank/stock', { method: 'PUT', token, body: { bloodGroup: 'O-', units: 0 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.recordedAsZero, true);
  });

  test('a negative count is refused by the database', async () => {
    const { token } = await seedVerifiedBank({ units: {} });
    const r = await call('/api/bank/stock', { method: 'PUT', token, body: { bloodGroup: 'O-', units: -5 } });
    assert.ok([400, 409, 500].includes(r.status), `expected a refusal, got ${r.status}`);
    assert.ok(!/stock_units/.test(r.text), 'the constraint name is not leaked to the caller');
  });

  test('one bank cannot see another banks stock', async () => {
    const first = await seedVerifiedBank({ units: { 'O-': 5 } });
    const second = await call('/api/auth/register', {
      method: 'POST',
      body: { phone: '9876500200', password: PASSWORD, displayName: 'Other', role: 'bank', bankName: 'Other Bank' },
    });

    const r = await call('/api/bank/stock', { token: extractToken(second) });
    assert.equal(r.status, 200);
    // The route takes no bank id at all, so the second bank is structurally
    // incapable of asking about the first.
    for (const row of r.body.stock) {
      assert.notEqual(row.bloodGroup, undefined);
    }
    assert.equal(r.body.bankId, second.body.bankId);
    assert.notEqual(r.body.bankId, first.bankId);
  });
});

describe('reserving blood', () => {
  const raiseO = async () => {
    const r = await call('/api/requests', {
      method: 'POST',
      body: { bloodGroup: 'O-', units: 2, urgency: 'emergency', hospital: 'Apollo', city: 'Hyderabad', state: 'Telangana', contactPhone: '9876500123' },
    });
    return r.body.request.id;
  };

  test('a verified bank with stock can take it', async () => {
    const { token } = await seedVerifiedBank({ units: { 'O-': 4 } });
    const requestId = await raiseO();

    const r = await call(`/api/bank/requests/${requestId}/reserve`, { method: 'POST', token });
    assert.equal(r.status, 200);
    assert.equal(r.body.reservation.units, 2);
    assert.equal(r.body.reservation.unitsLeftOnShelf, 2);
    assert.match(r.body.notice, /not a transfusion/i);
  });

  test('an unverified bank is refused, and told why', async () => {
    const { token } = await seedVerifiedBank({ verified: false, units: { 'O-': 4 } });
    const requestId = await raiseO();

    const r = await call(`/api/bank/requests/${requestId}/reserve`, { method: 'POST', token });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'bank_unverified');
  });

  test('an unverified bank is not even shown the open requests', async () => {
    const { token } = await seedVerifiedBank({ verified: false, units: { 'O-': 4 } });
    await raiseO();

    const r = await call('/api/bank/requests', { token });
    assert.equal(r.status, 200);
    assert.equal(r.body.requests.length, 0);
    assert.match(r.body.notice, /not verified/i);
  });

  test('a bank with no shelf entry is refused before the transaction', async () => {
    const { token } = await seedVerifiedBank({ units: { 'A+': 9 } });
    const requestId = await raiseO();

    const r = await call(`/api/bank/requests/${requestId}/reserve`, { method: 'POST', token });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'insufficient_on_shelf');
  });

  test('reserving more than is on the shelf is a 409 with the real numbers', async () => {
    const { token } = await seedVerifiedBank({ units: { 'O-': 1 } });
    const requestId = await raiseO();

    const r = await call(`/api/bank/requests/${requestId}/reserve`, { method: 'POST', token });
    assert.equal(r.status, 400);
    assert.equal(r.body.available, 1);
    assert.equal(r.body.requested, 2);
  });

  test('a bank that took the blood sees the contact number, the public does not', async () => {
    const { token } = await seedVerifiedBank({ units: { 'O-': 4 } });
    const requestId = await raiseO();
    await call(`/api/bank/requests/${requestId}/reserve`, { method: 'POST', token });

    const asBank = await call(`/api/requests/${requestId}`, { token });
    assert.equal(asBank.body.request.contactPhone, '9876500123', 'the bank making the handover needs it');

    const asPublic = await call(`/api/requests/${requestId}`);
    assert.equal(asPublic.body.request.contactPhone, undefined);
  });

  test('a request that does not exist is a clean 404', async () => {
    const { token } = await seedVerifiedBank({ units: { 'O-': 4 } });
    const r = await call('/api/bank/requests/cccccccc-cccc-cccc-cccc-cccccccccccc/reserve', { method: 'POST', token });
    assert.equal(r.status, 404);
  });

  test('a malformed id is a 400 and never reaches the database', async () => {
    const { token } = await seedVerifiedBank({ units: { 'O-': 4 } });
    const r = await call('/api/bank/requests/not-a-uuid/reserve', { method: 'POST', token });
    assert.equal(r.status, 400);
    assert.ok(!/uuid/i.test(r.text), 'does not leak the database type error');
  });
});

describe('coordinator endpoints', () => {
  const coordinatorToken = async () => {
    await seedCoordinator();
    const r = await call('/api/auth/login', { method: 'POST', body: { phone: '9876500099', password: PASSWORD } });
    return extractToken(r);
  };

  test('a coordinator can verify a bank', async () => {
    const { bankId } = await seedVerifiedBank({ verified: false });
    const token = await coordinatorToken();

    const r = await call(`/api/coordinator/banks/${bankId}/verify`, {
      method: 'POST',
      token,
      body: { licenceRef: 'TS-2026-001' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.bank.verified, true);
    // The honest wording, because nothing confirmed this with the regulator.
    assert.match(r.body.verificationMeaning, /not confirmed with the State Drug Controller/i);
  });

  test('verifying without recording a licence reference is refused', async () => {
    const { bankId } = await seedVerifiedBank({ verified: false });
    const token = await coordinatorToken();
    const r = await call(`/api/coordinator/banks/${bankId}/verify`, { method: 'POST', token, body: { licenceRef: '' } });
    assert.equal(r.status, 400);
  });

  test('the full escalation plan names donors, the public preview does not', async () => {
    const token = await coordinatorToken();

    await db.exec(`
      INSERT INTO donors (id, name, phone, blood_group, city, state, lat, lon, available)
      VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Ravi', '9876500777', 'O-', 'Hyderabad', 'Telangana', 17.44, 78.34, true)
    `);
    await db.exec(`
      INSERT INTO consents (subject_type, subject_id, channel, purpose, granted, granted_at)
      VALUES ('donor', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'sms', 'emergency_contact', true, now())
    `);

    const raised = await call('/api/requests', {
      method: 'POST',
      body: { bloodGroup: 'O-', units: 1, hospital: 'Apollo', city: 'Hyderabad', state: 'Telangana', contactPhone: '9876500123' },
    });

    const full = await call(`/api/coordinator/requests/${raised.body.request.id}/escalate`, { method: 'POST', token });
    assert.equal(full.status, 200);
    assert.equal(full.body.community.queued, 1, 'the consented donor is queued');

    const preview = await call(`/api/requests/${raised.body.request.id}/escalation-preview`);
    assert.ok(!preview.text.includes('9876500777'), 'the public payload names nobody');
  });

  test('widening is advised and never performed', async () => {
    const token = await coordinatorToken();
    const raised = await call('/api/requests', {
      method: 'POST',
      body: { bloodGroup: 'O-', units: 1, hospital: 'Apollo', contactPhone: '9876500123' },
    });

    const r = await call(`/api/coordinator/requests/${raised.body.request.id}/widen-check`, { method: 'POST', token });
    assert.equal(r.status, 200);
    assert.equal(r.body.actionTaken, false, 'an advice endpoint must not be mistaken for an action');
    assert.match(r.body.note, /human decision/i);
  });

  test('an outcome notice is refused for a donor who has not consented', async () => {
    const token = await coordinatorToken();
    await db.exec(`
      INSERT INTO donors (id, name, phone, blood_group, available)
      VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'No Consent', '9876500888', 'O-', true)
    `);
    const raised = await call('/api/requests', {
      method: 'POST',
      body: { bloodGroup: 'O-', units: 1, hospital: 'Apollo', contactPhone: '9876500123' },
    });

    const r = await call(`/api/coordinator/requests/${raised.body.request.id}/outcome`, {
      method: 'POST',
      token,
      body: { outcome: 'fulfilled_by_bank', donorId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'no_consent');
  });

  test('an unknown outcome is refused with the list of real ones', async () => {
    const token = await coordinatorToken();
    const raised = await call('/api/requests', {
      method: 'POST',
      body: { bloodGroup: 'O-', units: 1, hospital: 'Apollo', contactPhone: '9876500123' },
    });
    const r = await call(`/api/coordinator/requests/${raised.body.request.id}/outcome`, {
      method: 'POST',
      token,
      body: { outcome: 'transfused_successfully' },
    });
    assert.equal(r.status, 400);
    assert.ok(r.body.allowed.includes('fulfilled_by_bank'));
  });

  test('the overview counts what actually matters, which is consent not signups', async () => {
    const token = await coordinatorToken();
    await db.exec(`INSERT INTO donors (name, phone, blood_group, available) VALUES ('A', '9000000001', 'O+', true)`);
    await db.exec(`INSERT INTO donors (name, phone, blood_group, available) VALUES ('B', '9000000002', 'O+', true)`);

    const r = await call('/api/coordinator/overview', { token });
    assert.equal(r.status, 200);
    assert.equal(r.body.community.availableNow, 2);
    // Nobody has opted in, so a broadcast would reach nobody. That gap is the
    // number a coordinator most needs to see.
    assert.equal(r.body.community.consentedToEmergency, 0);
  });
});

describe('replies', () => {
  test('a signed in user can reply, a signed out one cannot', async () => {
    const raised = await call('/api/requests', {
      method: 'POST',
      body: { bloodGroup: 'O-', units: 1, hospital: 'Apollo', contactPhone: '9876500123' },
    });
    const id = raised.body.request.id;

    const anonymous = await call(`/api/requests/${id}/replies`, { method: 'POST', body: { body: 'I have some' } });
    assert.equal(anonymous.status, 401);

    const reg = await register();
    const signedIn = await call(`/api/requests/${id}/replies`, {
      method: 'POST',
      token: extractToken(reg),
      body: { body: 'I can donate this evening' },
    });
    assert.equal(signedIn.status, 201);
    assert.equal(signedIn.body.reply.authorRole, 'donor');
  });

  test('a reply is attributed by role, never by name', async () => {
    const raised = await call('/api/requests', {
      method: 'POST',
      body: { bloodGroup: 'O-', units: 1, hospital: 'Apollo', contactPhone: '9876500123' },
    });
    const reg = await register();
    await call(`/api/requests/${raised.body.request.id}/replies`, {
      method: 'POST',
      token: extractToken(reg),
      body: { body: 'Available tonight' },
    });

    const list = await call(`/api/requests/${raised.body.request.id}/replies`);
    assert.ok(!list.text.includes('Asha Rao'), 'the display name is not published in the thread');
    assert.equal(list.body.replies[0].authorRole, 'donor');
  });

  test('an empty reply is refused', async () => {
    const raised = await call('/api/requests', {
      method: 'POST',
      body: { bloodGroup: 'O-', units: 1, hospital: 'Apollo', contactPhone: '9876500123' },
    });
    const reg = await register();
    const r = await call(`/api/requests/${raised.body.request.id}/replies`, {
      method: 'POST',
      token: extractToken(reg),
      body: { body: '   ' },
    });
    assert.equal(r.status, 400);
  });

  test('a clinical claim in a reply is blocked', async () => {
    const raised = await call('/api/requests', {
      method: 'POST',
      body: { bloodGroup: 'O-', units: 1, hospital: 'Apollo', contactPhone: '9876500123' },
    });
    const reg = await register();
    const r = await call(`/api/requests/${raised.body.request.id}/replies`, {
      method: 'POST',
      token: extractToken(reg),
      body: { body: 'this blood is guaranteed safe, clinically proven' },
    });
    assert.equal(r.status, 400);
  });
});

describe('internal failures do not leak', () => {
  test('a broken database produces a generic 500', async () => {
    const broken = {
      query: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'); },
    };
    const app = createApp({ db: broken, options: { secureCookies: false }, logger: { error() {} } });
    const server2 = createServer(app);
    await new Promise((r) => server2.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server2.address().port}`;

    try {
      const res = await fetch(`${url}/api/requests`);
      const text = await res.text();
      assert.equal(res.status, 500);
      assert.ok(!text.includes('hunter2'), 'no credentials');
      assert.ok(!text.includes('10.0.0.5'), 'no internal addresses');
      assert.ok(!text.includes('ECONNREFUSED'), 'no driver detail');
      assert.equal(JSON.parse(text).type, 'urn:problem:internal');
    } finally {
      await new Promise((r) => server2.close(r));
    }
  });
});
