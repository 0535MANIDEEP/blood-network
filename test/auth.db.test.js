import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDatabase, migrate, reset } from '../src/db/client.js';
import { reserveStock, BankNotVerifiedError } from '../src/db/inventory.js';
import { LoginThrottle } from '../src/auth/rate-limit.js';
import { can } from '../src/auth/rbac.js';
import {
  registerAccount,
  login,
  logout,
  resolveSession,
  revokeAllSessions,
  requestPasswordReset,
  completePasswordReset,
  normalisePhone,
  AuthError,
} from '../src/auth/service.js';
import { WeakPasswordError } from '../src/auth/password.js';

/**
 * These run against a real PostgreSQL engine. Most of what matters in an account
 * system is enforced by the schema, so testing it against a mock would test the
 * mock: the role constraint, the unique phone, the session expiry columns and
 * the cascade on delete are all real.
 */

let db;

// scrypt at production cost is slow enough to dominate the suite. Production
// code passes nothing and gets the real parameters; only these tests override,
// and only the cost, never the algorithm.
const FAST = Object.freeze({ N: 1024, r: 8, p: 1, keyLength: 32 });
const PASSWORD = 'a decent long password';

const phoneOf = (n) => `98765${String(n).padStart(5, '0')}`;

const newThrottle = () => new LoginThrottle();

before(async () => {
  db = await createDatabase();
  await migrate(db);
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await reset(db);
});

describe('registration creates the account and the record it acts as', () => {
  test('a donor gets a donor record and a user pointing at it', async () => {
    const result = await registerAccount(
      db,
      { phone: phoneOf(1), password: PASSWORD, displayName: 'Asha Rao', role: 'donor', bloodGroup: 'O+', city: 'Hyderabad', state: 'Telangana' },
      { passwordCost: FAST },
    );

    assert.equal(result.user.role, 'donor');
    assert.ok(result.donorId, 'a donor record exists');
    assert.equal(result.bankId, null);

    const donors = await db.query('SELECT name, phone, blood_group FROM donors WHERE id = $1', [result.donorId]);
    assert.equal(donors[0].name, 'Asha Rao');
    assert.equal(donors[0].phone, '+919876500001');
    assert.equal(donors[0].blood_group, 'O+');
  });

  test('a bank gets a bank record and a user pointing at it', async () => {
    const result = await registerAccount(
      db,
      { phone: phoneOf(2), password: PASSWORD, displayName: 'Kiran', role: 'bank', bankName: 'City Blood Bank', city: 'Hyderabad', state: 'Telangana' },
      { passwordCost: FAST },
    );

    assert.equal(result.user.role, 'bank');
    assert.ok(result.bankId);
    assert.equal(result.donorId, null);
  });

  test('the phone is normalised so one person cannot hold two accounts', async () => {
    await registerAccount(
      db,
      { phone: '9876500003', password: PASSWORD, displayName: 'Asha Rao', role: 'donor', bloodGroup: 'O+' },
      { passwordCost: FAST },
    );
    // Same number typed the way a person actually types it.
    await assert.rejects(
      () =>
        registerAccount(
          db,
          { phone: '+91 98765 00003', password: PASSWORD, displayName: 'Impostor', role: 'donor', bloodGroup: 'A+' },
          { passwordCost: FAST },
        ),
      (err) => err instanceof AuthError && err.code === 'unavailable',
    );

    const users = await db.query('SELECT count(*)::int c FROM users');
    assert.equal(users[0].c, 1, 'still one account');
  });

  test('a duplicate registration reveals nothing about the existing account', async () => {
    await registerAccount(
      db,
      { phone: phoneOf(4), password: PASSWORD, displayName: 'Asha Rao', role: 'donor', bloodGroup: 'O+' },
      { passwordCost: FAST },
    );
    await assert.rejects(
      () =>
        registerAccount(
          db,
          { phone: phoneOf(4), password: 'a different password', displayName: 'Asha Rao', role: 'donor', bloodGroup: 'O+' },
          { passwordCost: FAST },
        ),
      (err) => err.message === 'Phone number or password is incorrect.',
    );
  });

  test('a failed registration leaves no orphan record behind', async () => {
    // A donor row with no user is a person who thinks they registered and cannot
    // log in. The insert has to be one transaction.
    await assert.rejects(
      () =>
        registerAccount(
          db,
          { phone: phoneOf(5), password: PASSWORD, displayName: 'Asha', role: 'donor', bloodGroup: 'NOT_A_GROUP' },
          { passwordCost: FAST },
        ),
    );

    const donors = await db.query('SELECT count(*)::int c FROM donors');
    const users = await db.query('SELECT count(*)::int c FROM users');
    assert.equal(donors[0].c, 0, 'no donor row survives a failed registration');
    assert.equal(users[0].c, 0);
  });
});

describe('a self registered bank cannot supply blood', () => {
  test('registration leaves verified_at null', async () => {
    const { bankId } = await registerAccount(
      db,
      { phone: phoneOf(6), password: PASSWORD, displayName: 'Kiran', role: 'bank', bankName: 'City Blood Bank' },
      { passwordCost: FAST },
    );

    const banks = await db.query('SELECT verified_at FROM banks WHERE id = $1', [bankId]);
    assert.equal(banks[0].verified_at, null, 'a signup is not evidence of a licence');
  });

  test('and its stock cannot be reserved, even by its own account', async () => {
    const { bankId } = await registerAccount(
      db,
      { phone: phoneOf(7), password: PASSWORD, displayName: 'Kiran', role: 'bank', bankName: 'City Blood Bank' },
      { passwordCost: FAST },
    );

    await db.query('INSERT INTO inventory (bank_id, blood_group, units) VALUES ($1, $2, $3)', [bankId, 'O-', 5]);

    const request = await db.query(
      `INSERT INTO requests (blood_group, units, hospital) VALUES ('O-', 1, 'Apollo') RETURNING id`,
    );

    await assert.rejects(
      () => reserveStock(db, { bankId, requestId: request[0].id, bloodGroup: 'O-', units: 1 }),
      BankNotVerifiedError,
    );
  });

  test('verification is what unlocks it, and only a coordinator can do that', async () => {
    const { bankId, user } = await registerAccount(
      db,
      { phone: phoneOf(8), password: PASSWORD, displayName: 'Kiran', role: 'bank', bankName: 'City Blood Bank' },
      { passwordCost: FAST },
    );

    const bankUser = await db.query('SELECT id, role, bank_id FROM users WHERE id = $1', [user.id]);
    assert.equal(can(bankUser[0], 'bank:verify'), false, 'a bank cannot verify itself');

    await db.query('INSERT INTO inventory (bank_id, blood_group, units) VALUES ($1, $2, $3)', [bankId, 'O-', 5]);
    await db.query('UPDATE banks SET verified_at = now() WHERE id = $1', [bankId]);

    const request = await db.query(
      `INSERT INTO requests (blood_group, units, hospital) VALUES ('O-', 1, 'Apollo') RETURNING id`,
    );
    const held = await reserveStock(db, { bankId, requestId: request[0].id, bloodGroup: 'O-', units: 1 });
    assert.equal(held.units, 1, 'verified banks can supply');
  });
});

describe('the database refuses a mismatched role and subject', () => {
  test('a bank account cannot be pointed at a donor record', async () => {
    const { donorId } = await registerAccount(
      db,
      { phone: phoneOf(9), password: PASSWORD, displayName: 'Asha', role: 'donor', bloodGroup: 'O+' },
      { passwordCost: FAST },
    );
    const { user } = await registerAccount(
      db,
      { phone: phoneOf(10), password: PASSWORD, displayName: 'Kiran', role: 'bank', bankName: 'City Blood Bank' },
      { passwordCost: FAST },
    );

    // Without the CHECK constraint a compromised bank account could act as a
    // person. This is the test that proves the constraint exists.
    await assert.rejects(() =>
      db.exec(`UPDATE users SET donor_id = '${donorId}' WHERE id = '${user.id}'`),
    );
  });

  test('a coordinator cannot be given a subject to act as', async () => {
    await db.exec(`
      INSERT INTO users (phone, password_hash, role, display_name, bank_id)
      VALUES ('+919876500099', 'x', 'coordinator', 'Sneha', '11111111-1111-1111-1111-111111111111')
    `).then(
      () => assert.fail('the role constraint should have rejected this'),
      () => {},
    );
  });

  test('an unknown role is refused', async () => {
    await db.exec(`
      INSERT INTO banks (id, name, city, state) VALUES ('22222222-2222-2222-2222-222222222222', 'B', 'C', 'S')
    `);
    await db.exec(`
      INSERT INTO users (phone, password_hash, role, display_name, bank_id)
      VALUES ('+919876500098', 'x', 'admin', 'Root', '22222222-2222-2222-2222-222222222222')
    `).then(
      () => assert.fail('the role CHECK should have rejected this'),
      () => {},
    );
  });

  test('coordinators cannot be self registered', async () => {
    await assert.rejects(
      () =>
        registerAccount(
          db,
          { phone: phoneOf(11), password: PASSWORD, displayName: 'Sneha', role: 'coordinator' },
          { passwordCost: FAST },
        ),
      (err) => err instanceof AuthError && err.code === 'role_not_self_serve',
    );
  });
});

describe('login', () => {
  const register = (n, over = {}) =>
    registerAccount(
      db,
      { phone: phoneOf(n), password: PASSWORD, displayName: 'Asha', role: 'donor', bloodGroup: 'O+', ...over },
      { passwordCost: FAST },
    );

  test('correct credentials return a token and the user', async () => {
    await register(20);
    const result = await login(db, { phone: phoneOf(20), password: PASSWORD }, { throttle: newThrottle() });
    assert.ok(result.token);
    assert.equal(result.user.role, 'donor');
    assert.ok(result.user.subjectId, 'the linked record is exposed, not the raw columns');
  });

  test('a wrong password is refused with a generic message', async () => {
    await register(21);
    await assert.rejects(
      () => login(db, { phone: phoneOf(21), password: 'wrong password' }, { throttle: newThrottle() }),
      (err) => err.code === 'bad_credentials' && err.message === 'Phone number or password is incorrect.',
    );
  });

  test('an unregistered phone gets the same message as a wrong password', async () => {
    await register(22);
    const unknown = await login(db, { phone: phoneOf(23), password: PASSWORD }, { throttle: newThrottle() }).catch((e) => e);
    const wrong = await login(db, { phone: phoneOf(22), password: 'nope nope nope' }, { throttle: newThrottle() }).catch((e) => e);

    assert.equal(unknown.message, wrong.message, 'no registration oracle');
    assert.equal(unknown.code, wrong.code);
  });

  test('the password hash is never returned to the caller', async () => {
    await register(24);
    const result = await login(db, { phone: phoneOf(24), password: PASSWORD }, { throttle: newThrottle() });
    assert.equal(result.user.password_hash, undefined);
    assert.equal(JSON.stringify(result.user).includes('scrypt'), false);
  });

  test('a disabled account cannot log in', async () => {
    const { user } = await register(25);
    await db.query('UPDATE users SET disabled_at = now() WHERE id = $1', [user.id]);

    await assert.rejects(
      () => login(db, { phone: phoneOf(25), password: PASSWORD }, { throttle: newThrottle() }),
      (err) => err.message === 'Phone number or password is incorrect.',
    );
  });

  test('brute force is throttled', async () => {
    await register(26);
    const throttle = newThrottle();
    for (let i = 0; i < 5; i += 1) {
      await login(db, { phone: phoneOf(26), password: 'wrong', source: '1.1.1.1' }, { throttle }).catch(() => {});
    }
    // Even the correct password is now refused, which is the point: the correct
    // password should not be guessable by an attacker who kept trying.
    await assert.rejects(
      () => login(db, { phone: phoneOf(26), password: PASSWORD, source: '1.1.1.1' }, { throttle }),
      (err) => err.code === 'throttled',
    );
  });

  test('a weak password cannot even be registered', async () => {
    await assert.rejects(
      () => registerAccount(db, { phone: phoneOf(27), password: 'short1!', displayName: 'Asha', role: 'donor', bloodGroup: 'O+' }, { passwordCost: FAST }),
      WeakPasswordError,
    );
  });
});

describe('sessions', () => {
  const setup = async (n) => {
    const registered = await registerAccount(
      db,
      { phone: phoneOf(n), password: PASSWORD, displayName: 'Asha', role: 'donor', bloodGroup: 'O+' },
      { passwordCost: FAST },
    );
    const session = await login(db, { phone: phoneOf(n), password: PASSWORD }, { throttle: newThrottle() });
    return { registered, session };
  };

  test('a valid token resolves to the user', async () => {
    const { session } = await setup(30);
    const resolved = await resolveSession(db, session.token);
    assert.equal(resolved.authenticated, true);
    assert.equal(resolved.user.phone, '+919876500030');
  });

  test('the database stores only the hash of the token', async () => {
    const { session } = await setup(31);
    const rows = await db.query('SELECT token_hash FROM sessions');
    assert.ok(!rows.some((r) => r.token_hash === session.token), 'the plaintext token is not in the table');
    assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)));
  });

  test('an unknown token is refused', async () => {
    const resolved = await resolveSession(db, 'not-a-real-token');
    assert.equal(resolved.authenticated, false);
    assert.equal(resolved.reason, 'no_session');
  });

  test('a missing token is refused without a database round trip', async () => {
    for (const bad of ['', null, undefined]) {
      assert.equal((await resolveSession(db, bad)).reason, 'no_token', String(bad));
    }
  });

  test('logging out kills the session immediately', async () => {
    const { session } = await setup(32);
    assert.equal((await resolveSession(db, session.token)).authenticated, true);
    await logout(db, session.token);
    const after = await resolveSession(db, session.token);
    assert.equal(after.authenticated, false);
    assert.equal(after.reason, 'revoked');
  });

  test('an absolutely expired session is refused', async () => {
    const { session } = await setup(33);
    await db.query('UPDATE sessions SET absolute_expires_at = $2 WHERE token_hash = $1', [
      (await import('../src/auth/session.js')).hashToken(session.token),
      new Date(Date.now() - 1000),
    ]);
    const resolved = await resolveSession(db, session.token);
    assert.equal(resolved.authenticated, false);
    assert.equal(resolved.reason, 'expired_absolute');
  });

  test('an idle expired session is refused', async () => {
    const { session } = await setup(34);
    await db.query('UPDATE sessions SET idle_expires_at = $2 WHERE token_hash = $1', [
      (await import('../src/auth/session.js')).hashToken(session.token),
      new Date(Date.now() - 1000),
    ]);
    const resolved = await resolveSession(db, session.token);
    assert.equal(resolved.authenticated, false);
    assert.equal(resolved.reason, 'expired_idle');
  });

  test('use slides the idle window but never past the absolute cap', async () => {
    const { session } = await setup(35);
    const absolute = new Date(Date.now() + 2 * 3_600_000);

    // The session must still be VALID, or the slide never happens. An already
    // expired session is rejected on the way in and its window is left alone,
    // which is the correct behaviour and a different test.
    await db.query(
      'UPDATE sessions SET absolute_expires_at = $2, idle_expires_at = $3 WHERE token_hash = $1',
      [
        (await import('../src/auth/session.js')).hashToken(session.token),
        absolute,
        new Date(Date.now() + 60 * 60_000),
      ],
    );

    const resolved = await resolveSession(db, session.token, new Date(), { idleMinutes: 7 * 24 * 60 });
    assert.equal(resolved.authenticated, true);

    const rows = await db.query('SELECT idle_expires_at, absolute_expires_at FROM sessions WHERE token_hash = $1', [
      (await import('../src/auth/session.js')).hashToken(session.token),
    ]);

    assert.equal(
      new Date(rows[0].idle_expires_at).getTime(),
      absolute.getTime(),
      'the idle window was clamped to the absolute cap, not extended past it',
    );
    assert.ok(
      new Date(rows[0].idle_expires_at) <= new Date(rows[0].absolute_expires_at),
      'the stored idle window never outlasts the stored absolute window',
    );
  });

  test('an already expired idle window is not slid forward', async () => {
    // The tempting bug: refresh first, check expiry second, and a session that
    // died an hour ago comes back to life on its next request.
    const { session } = await setup(39);
    const staleIdle = new Date(Date.now() - 60 * 60_000);

    await db.query('UPDATE sessions SET idle_expires_at = $2 WHERE token_hash = $1', [
      (await import('../src/auth/session.js')).hashToken(session.token),
      staleIdle,
    ]);

    const resolved = await resolveSession(db, session.token);
    assert.equal(resolved.authenticated, false);
    assert.equal(resolved.reason, 'expired_idle');

    const rows = await db.query('SELECT idle_expires_at FROM sessions WHERE token_hash = $1', [
      (await import('../src/auth/session.js')).hashToken(session.token),
    ]);
    assert.equal(
      new Date(rows[0].idle_expires_at).getTime(),
      staleIdle.getTime(),
      'the window was not quietly renewed',
    );
  });

  test('disabling an account kills its live sessions', async () => {
    const { registered, session } = await setup(36);
    assert.equal((await resolveSession(db, session.token)).authenticated, true);
    await db.query('UPDATE users SET disabled_at = now() WHERE id = $1', [registered.user.id]);
    const resolved = await resolveSession(db, session.token);
    assert.equal(resolved.authenticated, false);
    assert.equal(resolved.reason, 'account_disabled');
  });

  test('deleting a user cascades to their sessions', async () => {
    const { registered, session } = await setup(37);
    await db.query('DELETE FROM users WHERE id = $1', [registered.user.id]);
    const rows = await db.query('SELECT count(*)::int c FROM sessions');
    assert.equal(rows[0].c, 0, 'no sessions are orphaned by a deleted account');
    assert.equal((await resolveSession(db, session.token)).authenticated, false);
  });

  test('revokeAllSessions reports how many it killed', async () => {
    const { registered, session } = await setup(38);
    await login(db, { phone: phoneOf(38), password: PASSWORD }, { throttle: newThrottle() });
    const result = await revokeAllSessions(db, registered.user.id);
    assert.equal(result.revoked, 2);
    assert.equal((await resolveSession(db, session.token)).authenticated, false);
  });
});

describe('password reset', () => {
  const setup = async (n) => {
    const registered = await registerAccount(
      db,
      { phone: phoneOf(n), password: PASSWORD, displayName: 'Asha', role: 'donor', bloodGroup: 'O+' },
      { passwordCost: FAST },
    );
    const session = await login(db, { phone: phoneOf(n), password: PASSWORD }, { throttle: newThrottle() });
    return { registered, session };
  };

  test('an unknown number is accepted silently', async () => {
    // Same response either way, or the endpoint becomes an account enumerator.
    const unknown = await requestPasswordReset(db, { phone: phoneOf(40) });
    assert.deepEqual(unknown, { accepted: true, sent: false });
  });

  test('a known number produces a usable token', async () => {
    await setup(41);
    let delivered = null;
    const result = await requestPasswordReset(db, {
      phone: phoneOf(41),
      deliver: (payload) => { delivered = payload; },
    });

    assert.equal(result.sent, true);
    assert.ok(delivered.token);

    await completePasswordReset(db, { token: delivered.token, password: 'a brand new password' }, { passwordCost: FAST });
    const ok = await login(db, { phone: phoneOf(41), password: 'a brand new password' }, { throttle: newThrottle() });
    assert.ok(ok.token);
  });

  test('a reset kills the old sessions, which is the whole point', async () => {
    // If it did not, a reset would change the password while the attacker keeps
    // their cookie, and recovery would achieve nothing.
    const { session } = await setup(42);
    assert.equal((await resolveSession(db, session.token)).authenticated, true);

    let delivered = null;
    await requestPasswordReset(db, { phone: phoneOf(42), deliver: (p) => { delivered = p; } });
    await completePasswordReset(db, { token: delivered.token, password: 'a brand new password' }, { passwordCost: FAST });

    const resolved = await resolveSession(db, session.token);
    assert.equal(resolved.authenticated, false, "the attacker's cookie must stop working");
    assert.equal(resolved.reason, 'revoked');
  });

  test('a reset token is single use', async () => {
    await setup(43);
    let delivered = null;
    await requestPasswordReset(db, { phone: phoneOf(43), deliver: (p) => { delivered = p; } });
    await completePasswordReset(db, { token: delivered.token, password: 'first new password' }, { passwordCost: FAST });

    await assert.rejects(
      () => completePasswordReset(db, { token: delivered.token, password: 'second new password' }, { passwordCost: FAST }),
      (err) => err.code === 'bad_reset_token',
    );
  });

  test('asking twice retires the older link', async () => {
    // Otherwise two live reset links exist and the older one, which may have
    // been seen, still works.
    await setup(44);
    const delivered = [];
    await requestPasswordReset(db, { phone: phoneOf(44), deliver: (p) => delivered.push(p) });
    await requestPasswordReset(db, { phone: phoneOf(44), deliver: (p) => delivered.push(p) });

    await assert.rejects(
      () => completePasswordReset(db, { token: delivered[0].token, password: 'some new password' }, { passwordCost: FAST }),
      (err) => err.code === 'bad_reset_token',
      'the superseded link must not work',
    );
    await completePasswordReset(db, { token: delivered[1].token, password: 'some new password' }, { passwordCost: FAST });
  });

  test('an expired token is refused', async () => {
    await setup(45);
    let delivered = null;
    await requestPasswordReset(db, { phone: phoneOf(45), deliver: (p) => { delivered = p; } });
    await db.query(`UPDATE password_resets SET expires_at = now() - interval '1 second'`);

    await assert.rejects(
      () => completePasswordReset(db, { token: delivered.token, password: 'some new password' }, { passwordCost: FAST }),
      (err) => err.code === 'bad_reset_token',
    );
  });

  test('a reset cannot set a weak password', async () => {
    await setup(46);
    let delivered = null;
    await requestPasswordReset(db, { phone: phoneOf(46), deliver: (p) => { delivered = p; } });
    await assert.rejects(
      () => completePasswordReset(db, { token: delivered.token, password: 'abc' }, { passwordCost: FAST }),
      WeakPasswordError,
    );
  });

  test('a disabled account cannot start a reset', async () => {
    const { registered } = await setup(47);
    await db.query('UPDATE users SET disabled_at = now() WHERE id = $1', [registered.user.id]);
    const result = await requestPasswordReset(db, { phone: phoneOf(47) });
    assert.equal(result.sent, false);
  });
});

describe('phone normalisation is what makes identity work', () => {
  test('every accepted format maps to one account', async () => {
    const target = normalisePhone('9876500005');
    for (const input of ['9876500005', '+919876500005', '09876500005', '91 98765 00005']) {
      assert.equal(normalisePhone(input), target, input);
    }
  });
});
