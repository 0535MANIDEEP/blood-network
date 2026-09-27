import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashPassword,
  verifyPassword,
  verifyPasswordOrDecoy,
  assessPasswordStrength,
  WeakPasswordError,
} from '../src/auth/password.js';
import { LoginThrottle } from '../src/auth/rate-limit.js';
import { can, assertCan, canSeeDonorContact, ForbiddenError, UnauthenticatedError } from '../src/auth/rbac.js';
import {
  mintToken,
  hashToken,
  tokensMatch,
  evaluateSession,
  sessionCookie,
  clearSessionCookie,
  readSessionCookie,
} from '../src/auth/session.js';
import { normalisePhone } from '../src/auth/service.js';

// scrypt at production cost is deliberately slow. These tests are about the
// logic around the hash, not the hash's cost, so they use the minimum the
// function accepts. Production code passes nothing and gets the defaults.
const FAST = Object.freeze({ N: 1024, r: 8, p: 1, keyLength: 32 });

describe('password hashing', () => {
  test('a correct password verifies', async () => {
    const hash = await hashPassword('correct horse battery', FAST);
    assert.equal(await verifyPassword('correct horse battery', hash), true);
  });

  test('a wrong password does not verify', async () => {
    const hash = await hashPassword('correct horse battery', FAST);
    assert.equal(await verifyPassword('wrong horse battery', hash), false);
  });

  test('the plaintext is nowhere in the stored hash', async () => {
    const hash = await hashPassword('correct horse battery', FAST);
    assert.ok(!hash.includes('correct horse battery'));
  });

  test('two hashes of the same password differ, so the salt is per user', async () => {
    const a = await hashPassword('correct horse battery', FAST);
    const b = await hashPassword('correct horse battery', FAST);
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('correct horse battery', a), true);
    assert.equal(await verifyPassword('correct horse battery', b), true);
  });

  test('the stored form records the parameters it was made with', async () => {
    const hash = await hashPassword('correct horse battery', FAST);
    const [, N, r, p] = hash.split('$');
    assert.equal(N, String(FAST.N));
    assert.equal(r, String(FAST.r));
    assert.equal(p, String(FAST.p));
  });

  test('a garbage stored hash is refused rather than throwing', async () => {
    for (const bad of ['', 'nonsense', 'scrypt$1$2$3', 'bcrypt$1$2$3$4$5$6', null, undefined, 42]) {
      assert.equal(await verifyPassword('anything', bad), false, String(bad));
    }
  });

  test('a hash demanding absurd memory is refused instead of allocating it', async () => {
    // N=1073741824 would try to allocate a terabyte. Refusing is the only safe
    // answer to a value read out of the database.
    const hostile = 'scrypt$1073741824$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';
    assert.equal(await verifyPassword('anything', hostile), false);
  });
});

describe('password strength', () => {
  test('a short password is refused', async () => {
    assert.equal(assessPasswordStrength('short1!').acceptable, false);
    await assert.rejects(() => hashPassword('short1!', FAST), WeakPasswordError);
  });

  test('all digits is refused even when long enough', async () => {
    assert.equal(assessPasswordStrength('1234567890').acceptable, false);
  });

  test('a reasonable password is accepted', () => {
    assert.equal(assessPasswordStrength('correct horse battery').acceptable, true);
  });

  test('an absurdly long password is refused so it cannot burn cpu', () => {
    assert.equal(assessPasswordStrength('a'.repeat(201)).acceptable, false);
  });

  test('a non string is refused without throwing', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      assert.equal(assessPasswordStrength(bad).acceptable, false, String(bad));
    }
  });
});

describe('login cannot be used to discover which numbers are registered', () => {
  test('a missing account still performs the hashing work', async () => {
    const started = process.hrtime.bigint();
    await verifyPasswordOrDecoy('some password attempt', null);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // A real scrypt round. If the missing account case returned instantly, the
    // endpoint would be a registration oracle.
    assert.ok(elapsedMs > 1, `expected real hashing work, took ${elapsedMs.toFixed(2)}ms`);
  });

  test('both cases report the same false', async () => {
    const hash = await hashPassword('correct horse battery', FAST);
    assert.deepEqual(
      await verifyPasswordOrDecoy('wrong', null),
      await verifyPasswordOrDecoy('wrong', hash),
    );
  });
});

describe('login throttling', () => {
  test('a handful of failures is allowed, a grind is not', () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 5; i += 1) {
      assert.equal(t.check({ phone: '+919999999999', source: '1.1.1.1' }).allowed, true, `attempt ${i + 1}`);
      t.recordFailure({ phone: '+919999999999', source: '1.1.1.1' });
    }
    const blocked = t.check({ phone: '+919999999999', source: '1.1.1.1' });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, 'too_many_attempts');
    assert.ok(blocked.retryAfterMs > 0);
  });

  test('one attacker is stopped from grinding many accounts', () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 25; i += 1) {
      t.recordFailure({ phone: `+91999999999${i}`, source: '9.9.9.9' });
    }
    // A brand new account, never attacked per account, is still blocked.
    const fresh = t.check({ phone: '+919888888888', source: '9.9.9.9' });
    assert.equal(fresh.allowed, false, 'per source protection, not just per account');
  });

  test('one account attacked from many addresses is still stopped', () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 5; i += 1) {
      t.recordFailure({ phone: '+919999999999', source: `10.0.0.${i}` });
    }
    const blocked = t.check({ phone: '+919999999999', source: '10.0.0.99' });
    assert.equal(blocked.allowed, false, 'per account protection, not just per source');
  });

  test('a correct password clears the account counter', () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 4; i += 1) t.recordFailure({ phone: '+919999999999', source: '1.1.1.1' });
    t.recordSuccess({ phone: '+919999999999' });
    assert.equal(t.check({ phone: '+919999999999', source: '1.1.1.1' }).allowed, true);
  });

  test('the delay grows with each attempt', () => {
    const t = new LoginThrottle();
    const delays = [];
    for (let i = 0; i < 6; i += 1) {
      delays.push(t.recordFailure({ phone: '+919999999999', source: '1.1.1.1' }).retryAfterMs);
    }
    for (let i = 1; i < delays.length; i += 1) {
      assert.ok(delays[i] >= delays[i - 1], `delay ${i} (${delays[i]}) should not fall below ${delays[i - 1]}`);
    }
    assert.ok(delays.at(-1) >= 30_000, 'a determined attacker ends up waiting');
  });

  test('a source with many failures is reported as risky', () => {
    const t = new LoginThrottle();
    assert.equal(t.sourceRisk({ source: '1.1.1.1' }).level, 'none');
    for (let i = 0; i < 15; i += 1) t.recordFailure({ phone: `+91900000000${i}`, source: '5.5.5.5' });
    assert.equal(t.sourceRisk({ source: '5.5.5.5' }).level, 'elevated');
  });
});

describe('role and ownership are separate checks', () => {
  const donor = { id: 'u1', role: 'donor', donor_id: 'd1', bank_id: null };
  const bank = { id: 'u2', role: 'bank', donor_id: null, bank_id: 'b1' };
  const otherBank = { id: 'u3', role: 'bank', donor_id: null, bank_id: 'b2' };
  const coordinator = { id: 'u4', role: 'coordinator', donor_id: null, bank_id: null };

  test('a bank may write its own inventory', () => {
    assert.equal(can(bank, 'inventory:write:own', { bankId: 'b1' }), true);
  });

  test('the public user shape authorises the same as the raw row shape', () => {
    // Routes authorise against req.user, which is the public shape carrying
    // subjectId, not the database row carrying bank_id. Supporting only the row
    // shape fails closed rather than open, which is the safe direction but still
    // a bug: the bank cannot pass its own ownership check, cannot read its own
    // stock, and the 403 reads like a permissions problem rather than a mismatch.
    const asPublicUser = { id: 'u2', role: 'bank', displayName: 'Kiran', subjectId: 'b1' };

    assert.equal(can(asPublicUser, 'inventory:read:own', { bankId: 'b1' }), true);
    assert.equal(can(asPublicUser, 'inventory:read:own', { bankId: 'b2' }), false);
    assert.equal(assertCan(asPublicUser, 'inventory:write:own', { bankId: 'b1' }), true);
  });

  test('a public donor shape resolves its own record too', () => {
    const asPublicUser = { id: 'u1', role: 'donor', displayName: 'Asha', subjectId: 'd1' };
    assert.equal(can(asPublicUser, 'donor:availability:own', { donorId: 'd1' }), true);
    assert.equal(can(asPublicUser, 'donor:availability:own', { donorId: 'd2' }), false);
  });

  test('a bank may not write another banks inventory', () => {
    // This is the check that a role table on its own cannot express. Every bank
    // user has the same role, so "banks may edit inventory" is true and useless.
    assert.equal(can(bank, 'inventory:write:own', { bankId: 'b2' }), false);
    assert.equal(can(otherBank, 'inventory:write:own', { bankId: 'b1' }), false);
  });

  test('a bank has no blanket inventory permission to fall back on', () => {
    assert.equal(can(bank, 'inventory:write:any'), false);
    assert.equal(can(bank, 'inventory:write'), false);
  });

  test('a donor cannot touch inventory at all', () => {
    assert.equal(can(donor, 'inventory:write:own', { bankId: 'b1' }), false);
  });

  test('only a coordinator verifies a bank', () => {
    assert.equal(can(coordinator, 'bank:verify'), true);
    assert.equal(can(bank, 'bank:verify'), false);
    assert.equal(can(donor, 'bank:verify'), false);
  });

  test('only a coordinator broadcasts to the community', () => {
    assert.equal(can(coordinator, 'notification:broadcast'), true);
    assert.equal(can(donor, 'notification:broadcast'), false);
    assert.equal(can(bank, 'notification:broadcast'), false);
  });

  test('every role can raise a request and reply to one', () => {
    for (const user of [donor, bank, coordinator]) {
      assert.equal(can(user, 'request:raise'), true, user.role);
      assert.equal(can(user, 'request:reply'), true, user.role);
    }
  });

  test('an own scoped permission with no target is not a pass', () => {
    // Otherwise "check the bank can write this" with the target accidentally
    // omitted would authorise the write.
    assert.equal(can(bank, 'inventory:write:own'), false);
    assert.equal(can(bank, 'inventory:write:own', {}), false);
  });

  test('a coordinator owns no record, so an own scoped check cannot pass', () => {
    assert.equal(can(coordinator, 'inventory:write:own', { bankId: 'b1' }), false);
  });

  test('no user at all is refused everything', () => {
    for (const user of [null, undefined, {}]) {
      assert.equal(can(user, 'request:view'), false, String(user));
    }
  });

  test('assertCan throws the right error for each failure', () => {
    assert.equal(assertCan(bank, 'inventory:write:own', { bankId: 'b1' }), true);
    assert.throws(() => assertCan(bank, 'inventory:write:own', { bankId: 'b2' }), ForbiddenError);
    assert.throws(() => assertCan(donor, 'bank:verify'), ForbiddenError);
    assert.throws(() => assertCan(null, 'request:view'), UnauthenticatedError);
  });

  test('the reason distinguishes wrong role from wrong record', () => {
    try {
      assertCan(bank, 'inventory:write:own', { bankId: 'b2' });
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.reason, 'not_your_record');
    }
    try {
      assertCan(donor, 'bank:verify');
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.reason, 'role_not_permitted');
    }
  });
});

describe('donor contact details are not a public directory', () => {
  const donor = { role: 'donor', donor_id: 'd1' };
  const otherDonor = { role: 'donor', donor_id: 'd2' };
  const bank = { role: 'bank', bank_id: 'b1' };
  const coordinator = { role: 'coordinator' };

  test('a donor sees their own number', () => {
    assert.equal(canSeeDonorContact({ actor: donor, donorId: 'd1' }).allowed, true);
  });

  test('a donor does not get another donors number', () => {
    assert.equal(canSeeDonorContact({ actor: donor, donorId: 'd2' }).allowed, false);
  });

  test('a bank sees only a donor it is actually matched to', () => {
    assert.equal(canSeeDonorContact({ actor: bank, donorId: 'd1', reason: 'matched_donor' }).allowed, true);
    assert.equal(canSeeDonorContact({ actor: bank, donorId: 'd1' }).allowed, false);
  });

  test('a coordinator can see a donors number', () => {
    assert.equal(canSeeDonorContact({ actor: coordinator, donorId: 'd1' }).allowed, true);
  });

  test('an anonymous caller sees nobody', () => {
    assert.equal(canSeeDonorContact({ actor: null, donorId: 'd1' }).allowed, false);
  });
});

describe('session tokens', () => {
  test('tokens are long and unguessable', () => {
    const token = mintToken();
    assert.ok(token.length >= 43, `base64url of 32 bytes should be ~43 chars, got ${token.length}`);
    const seen = new Set(Array.from({ length: 500 }, mintToken));
    assert.equal(seen.size, 500, 'no collisions across 500 tokens');
  });

  test('only the hash is stored, never the token', () => {
    const token = mintToken();
    const hash = hashToken(token);
    assert.notEqual(hash, token);
    assert.ok(!hash.includes(token));
    assert.equal(hash.length, 64, 'sha256 hex');
  });

  test('hashes compare in constant time and correctly', () => {
    const a = hashToken('a');
    const b = hashToken('b');
    assert.equal(tokensMatch(a, a), true);
    assert.equal(tokensMatch(a, b), false);
  });

  test('a malformed hash comparison is refused rather than throwing', () => {
    for (const pair of [['abc', 'abc'], ['', ''], [null, null], ['zz', 'zz']]) {
      assert.equal(tokensMatch(pair[0], pair[1]), false, JSON.stringify(pair));
    }
  });
});

describe('session expiry', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  const live = (over = {}) => ({
    created_at: '2026-09-27T11:00:00Z',
    revoked_at: null,
    absolute_expires_at: '2026-10-27T12:00:00Z',
    idle_expires_at: '2026-10-01T12:00:00Z',
    ...over,
  });

  test('a live session is valid', () => {
    assert.equal(evaluateSession(live(), now).valid, true);
  });

  test('a revoked session is told apart from an expired one', () => {
    // These need different handling. A system that cannot tell them apart
    // revokes everything when it should refresh one.
    assert.equal(evaluateSession(live({ revoked_at: '2026-09-27T11:30:00Z' }), now).reason, 'revoked');
    assert.equal(evaluateSession(live({ absolute_expires_at: '2026-09-01T00:00:00Z' }), now).reason, 'expired_absolute');
    assert.equal(evaluateSession(live({ idle_expires_at: '2026-09-26T00:00:00Z' }), now).reason, 'expired_idle');
  });

  test('a missing session is not an error', () => {
    assert.equal(evaluateSession(null, now).reason, 'no_session');
  });

  test('a session older than the policy is flagged rather than quietly allowed', () => {
    const old = live({ created_at: '2026-01-01T00:00:00Z', absolute_expires_at: '2027-01-01T00:00:00Z' });
    const state = evaluateSession(old, now);
    assert.equal(state.valid, true);
    assert.equal(state.suspiciousAge, true, 'valid but far older than intended, worth logging');
  });

  test('a session with an unparseable expiry is refused, not treated as live', () => {
    // Silently reading a broken date as "no expiry" would make a corrupted row
    // immortal.
    assert.equal(evaluateSession(live({ absolute_expires_at: 'not a date' }), now).valid, false);
    assert.equal(evaluateSession(live({ idle_expires_at: null }), now).valid, false);
  });
});

describe('session cookie handling', () => {
  test('the cookie is httponly, samesite and secure', () => {
    const cookie = sessionCookie('abc123');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Path=\//);
  });

  test('clearing the cookie expires it immediately', () => {
    assert.match(clearSessionCookie(), /Max-Age=0/);
  });

  test('the token is read out of a cookie header', () => {
    assert.equal(readSessionCookie('bn_session=abc123'), 'abc123');
    assert.equal(readSessionCookie('other=1; bn_session=abc123; more=2'), 'abc123');
  });

  test('a missing or empty token yields null rather than an empty string', () => {
    assert.equal(readSessionCookie(''), null);
    assert.equal(readSessionCookie('other=1'), null);
    assert.equal(readSessionCookie('bn_session='), null);
    assert.equal(readSessionCookie(null), null);
  });
});

describe('phone normalisation', () => {
  test('indian numbers are accepted in the forms people actually type', () => {
    for (const input of ['9876543210', '+919876543210', '09876543210', '91 98765 43210', '+91 98765-43210']) {
      assert.equal(normalisePhone(input), '+919876543210', input);
    }
  });

  test('a wrong length or junk is refused', () => {
    for (const bad of ['12345', '1234567890123456', '', 'not a phone', null, 9876543210]) {
      assert.equal(normalisePhone(bad), null, String(bad));
    }
  });

  test('a leading 91 on a ten digit number is not doubled', () => {
    // '919876543210' is twelve digits starting 91, so it is the country code
    // form. '9876543210' is ten. Neither should become '+91919876543210'.
    assert.equal(normalisePhone('919876543210'), '+919876543210');
    assert.notEqual(normalisePhone('9876543210'), '+91919876543210');
  });
});
