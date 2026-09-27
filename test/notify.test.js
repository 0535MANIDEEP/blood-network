import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDatabase, migrate, reset } from '../src/db/client.js';
import { buildEscalationPlan } from '../src/domain/escalation.js';
import { toRequestDomain, toDonorPlanShape } from '../src/db/requests.js';
import { checkConsent, buildCommunityMessages, dispatchQueued, SKIP } from '../src/notify/dispatch.js';
import { buildMessage, dryRunChannel, deepLinkChannel, webhookChannel, NotificationRefused, BoundaryViolation } from '../src/notify/channels.js';

/**
 * The property that matters most in this file is the first describe block.
 *
 * Everything else here is plumbing. Whether a donor who opted out twenty seconds
 * ago still gets a message at 2am is the whole ballgame, and that is the thing
 * that gets decided by a developer taking a shortcut under time pressure.
 */

let db;

const NOW = new Date('2026-09-27T23:30:00Z');
const BANJARA = [17.4126, 78.4347];
const GACHIBOWLI = [17.4401, 78.3489];

const seedDonor = async (over = {}) => {
  const rows = await db.query(
    `INSERT INTO donors (id, name, phone, blood_group, city, state, lat, lon, available)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      over.id ?? '11111111-1111-1111-1111-111111111111',
      over.name ?? 'Ravi',
      over.phone ?? '9876500777',
      over.bloodGroup ?? 'O-',
      'Hyderabad',
      'Telangana',
      over.lat ?? GACHIBOWLI[0],
      over.lon ?? GACHIBOWLI[1],
      over.available ?? true,
    ],
  );
  return rows[0];
};

const grantConsent = async (donorId, over = {}) => {
  const rows = await db.query(
    `INSERT INTO consents (subject_type, subject_id, channel, purpose, granted, granted_at, revoked_at)
     VALUES ('donor', $1, $2, $3, $4, $5, $6)
     ON CONFLICT (subject_type, subject_id, channel, purpose)
     DO UPDATE SET granted = EXCLUDED.granted, revoked_at = EXCLUDED.revoked_at
     RETURNING *`,
    [
      donorId,
      over.channel ?? 'sms',
      over.purpose ?? 'emergency_contact',
      over.granted ?? true,
      over.granted ? NOW : null,
      over.revokedAt ?? null,
    ],
  );
  return rows[0];
};

const queueMessage = async (payload, over = {}) => {
  const rows = await db.query(
    `INSERT INTO notifications (channel, recipient, template, payload)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [over.channel ?? 'sms', payload.to ?? 'unknown', over.template ?? 'community_need', JSON.stringify(payload)],
  );
  return rows[0];
};

/** A channel that reports delivery, so status transitions are exercised. */
const deliveringChannel = (sink = []) => ({
  name: 'delivering',
  sendsNothing: false,
  async send(message) {
    sink.push(message);
    return { delivered: true };
  },
});

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

describe('consent is checked when the message is sent, not when it is queued', () => {
  const payloadFor = (donorId) => ({
    donorId,
    to: '9876500777',
    channel: 'sms',
    purpose: 'emergency_contact',
    subject: 'Blood needed: O-',
    body: 'A need for O negative. Not a blood bank, not a medical device.',
    requestId: 'req-1',
  });

  test('a consented donor is messaged', async () => {
    const donor = await seedDonor();
    await grantConsent(donor.id);
    const queued = await queueMessage(payloadFor(donor.id));
    const sink = [];

    // A channel that actually delivers, so the status transition is exercised.
    const result = await dispatchQueued(db, { channel: deliveringChannel(sink) });

    assert.equal(result.sent, 1);
    assert.equal(sink.length, 1);
    assert.equal(sink[0].to, '9876500777');

    const rows = await db.query('SELECT status FROM notifications WHERE id = $1', [queued.id]);
    assert.equal(rows[0].status, 'sent');
  });

  test('a dry run does not consume the queue', async () => {
    // Consuming it would mean exercising the dispatcher empties the queue, and
    // the real dispatch afterwards has nothing left to send, which is the worst
    // possible moment to discover.
    const donor = await seedDonor();
    await grantConsent(donor.id);
    const queued = await queueMessage(payloadFor(donor.id));

    const dry = await dispatchQueued(db, { channel: dryRunChannel([]) });
    assert.equal(dry.dryRun, 1);
    assert.equal(dry.sent, 0);
    assert.equal(dry.failed, 0, 'a dry run is not a failure');

    const rows = await db.query('SELECT status FROM notifications WHERE id = $1', [queued.id]);
    assert.equal(rows[0].status, 'queued', 'still waiting for a real dispatch');

    // And the real dispatch then works.
    const real = await dispatchQueued(db, { channel: deliveringChannel([]) });
    assert.equal(real.sent, 1);
  });

  test('a donor who never consented is skipped, whatever the queue says', async () => {
    const donor = await seedDonor();
    // No consent row at all. A caller that handed in a pre-filtered list could
    // get this wrong; reading the queue inside the loop cannot.
    const queued = await queueMessage(payloadFor(donor.id));
    const sink = [];

    const result = await dispatchQueued(db, { channel: dryRunChannel(sink) });

    assert.equal(result.sent, 0);
    assert.equal(result.skipped, 1);
    assert.equal(sink.length, 0, 'nothing reached the channel at all');

    const rows = await db.query('SELECT status FROM notifications WHERE id = $1', [queued.id]);
    assert.equal(rows[0].status, SKIP.NO_CONSENT);
  });

  test('a donor who opted out AFTER the message was queued is still skipped', async () => {
    // This is the whole point of checking at send time. Consent is revocable, so
    // the flag that was true when the coordinator pressed the button may no
    // longer be true by the time the dispatcher runs, and honouring the stale
    // value means the opt out did not work.
    const donor = await seedDonor();
    await grantConsent(donor.id);
    const queued = await queueMessage(payloadFor(donor.id));

    // The donor changes their mind while the message sits in the queue.
    await db.query('UPDATE consents SET granted = true, revoked_at = $2 WHERE subject_id = $1', [
      donor.id,
      new Date(NOW.getTime() + 60_000),
    ]);

    const sink = [];
    const result = await dispatchQueued(db, { channel: dryRunChannel(sink) });

    assert.equal(result.sent, 0);
    assert.equal(sink.length, 0);
    assert.equal(result.details[0].reason, 'revoked_after_granting');

    const rows = await db.query('SELECT status FROM notifications WHERE id = $1', [queued.id]);
    assert.equal(rows[0].status, SKIP.NO_CONSENT);
  });

  test('a donor who declined outright is skipped', async () => {
    const donor = await seedDonor();
    await grantConsent(donor.id, { granted: false });
    await queueMessage(payloadFor(donor.id));
    const sink = [];

    const result = await dispatchQueued(db, { channel: dryRunChannel(sink) });
    assert.equal(result.sent, 0);
    assert.equal(sink.length, 0);
  });

  test('consent for one purpose does not authorise another', async () => {
    // Opting in to be told about a nearby need is not opting in to everything.
    const donor = await seedDonor();
    await grantConsent(donor.id, { purpose: 'nearby_need' });
    await queueMessage({ ...payloadFor(donor.id), purpose: 'emergency_contact' });
    const sink = [];

    const result = await dispatchQueued(db, { channel: dryRunChannel(sink) });
    assert.equal(result.sent, 0);
    assert.equal(sink.length, 0);
  });

  test('consent on one channel does not authorise another', async () => {
    const donor = await seedDonor();
    await grantConsent(donor.id, { channel: 'sms' });
    await queueMessage({ ...payloadFor(donor.id), channel: 'telegram' });
    const sink = [];

    const result = await dispatchQueued(db, { channel: dryRunChannel(sink) });
    assert.equal(result.sent, 0);
  });
});

describe('consent checking on its own', () => {
  const base = { subjectType: 'donor', subjectId: 'd1', channel: 'sms', purpose: 'emergency_contact' };

  test('granted and never revoked is allowed', () => {
    assert.equal(checkConsent([{ ...base, subject_type: 'donor', subject_id: 'd1', channel: 'sms', purpose: 'emergency_contact', granted: true, revoked_at: null }], base).allowed, true);
  });

  test('granted but revoked is refused, and says why', () => {
    const verdict = checkConsent([{ subject_type: 'donor', subject_id: 'd1', channel: 'sms', purpose: 'emergency_contact', granted: true, revoked_at: '2026-01-01' }], base);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'revoked_after_granting');
  });

  test('no record at all is refused', () => {
    assert.equal(checkConsent([], base).reason, 'never_consented');
  });

  test('undefined consent input does not throw', () => {
    assert.equal(checkConsent(undefined, base).allowed, false);
  });
});

describe('no outbound message may claim clinical authority', () => {
  test('a message calling blood sterile is refused', () => {
    // Somebody in a corridor at 2am will believe this. This project ranks
    // compatibility and does not certify blood, so the message must not be sent
    // rather than sent and apologised for later.
    assert.throws(
      () => buildMessage({ to: '9876500777', channel: 'sms', subject: 'Blood needed', body: 'This unit is sterile and safe.' }),
      BoundaryViolation,
    );
  });

  test('a subject claiming transfusion readiness is refused', () => {
    assert.throws(
      () => buildMessage({ to: '9876500777', channel: 'sms', subject: 'transfusion ready', body: 'Available now.' }),
      BoundaryViolation,
    );
  });

  test('a message with no recipient is refused', () => {
    assert.throws(() => buildMessage({ channel: 'sms', subject: 'x', body: 'y' }), NotificationRefused);
  });

  test('a message with no body is refused', () => {
    assert.throws(() => buildMessage({ to: '9', channel: 'sms', subject: 'x' }), NotificationRefused);
  });

  test('a queued message that would claim safety fails the send, not the queue', () => {
    // The dispatcher marks it failed rather than throwing, so one bad message
    // cannot stop the rest of the queue reaching people who need telling.
    return (async () => {
      const donor = await seedDonor();
      await grantConsent(donor.id);
      await queueMessage({
        donorId: donor.id,
        to: '9876500777',
        channel: 'sms',
        purpose: 'emergency_contact',
        subject: 'Blood needed',
        body: 'clinically proven and guaranteed safe',
      });

      const sink = [];
      const result = await dispatchQueued(db, { channel: deliveringChannel(sink) });

      assert.equal(result.sent, 0);
      assert.equal(result.failed, 1);
      assert.equal(sink.length, 0);
    })();
  });
});

describe('channels', () => {
  test('the dry run channel records without sending', async () => {
    const sink = [];
    const channel = dryRunChannel(sink);
    const outcome = await channel.send({ to: '9', subject: 's', body: 'b' });

    assert.equal(outcome.delivered, false);
    assert.equal(outcome.reason, 'dry_run');
    assert.equal(sink.length, 1);
    assert.equal(channel.sendsNothing, true);
  });

  test('a webhook reports a gateway failure as a reason, not an exception', async () => {
    // One broken gateway must not take down a dispatch run for every other
    // channel in it.
    const channel = webhookChannel({
      url: 'https://gateway.invalid/send',
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    const outcome = await channel.send({ to: '9', subject: 's', body: 'b' });
    assert.equal(outcome.delivered, false);
    assert.equal(outcome.reason, 'gateway_503');
  });

  test('a webhook reports an unreachable gateway rather than throwing', async () => {
    const channel = webhookChannel({
      url: 'https://gateway.invalid/send',
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    const outcome = await channel.send({ to: '9', subject: 's', body: 'b' });
    assert.equal(outcome.delivered, false);
    assert.equal(outcome.reason, 'gateway_unreachable');
  });

  test('a webhook with no url is refused at construction', () => {
    assert.throws(() => webhookChannel({}), /needs a url/);
  });

  test('the deep link channel needs no gateway at all', async () => {
    const channel = deepLinkChannel({ baseUrl: 'https://app.example/donate' });
    const outcome = await channel.send({ to: '9', subject: 's', body: 'b', reference: 'req-7' });
    assert.equal(outcome.delivered, true);
    assert.match(outcome.link, /[?&]r=req-7$/);
  });

  test('the deep link channel degrades without a base url', async () => {
    const outcome = await deepLinkChannel({}).send({ to: '9', reference: 'r' });
    assert.equal(outcome.delivered, false);
  });
});

describe('one bad message does not stop the queue', () => {
  test('a later valid message still goes out', async () => {
    const good = await seedDonor();
    const alsoGood = await seedDonor({
      id: '22222222-2222-2222-2222-222222222222',
      phone: '9876500888',
    });

    await grantConsent(good.id);
    await grantConsent(alsoGood.id);

    // A message with no subject, which cannot be built.
    await queueMessage({ donorId: good.id, to: '9876500777', body: 'no subject here' });
    await queueMessage({
      donorId: alsoGood.id,
      to: '9876500888',
      subject: 'Blood needed: O-',
      body: 'A need for O negative nearby.',
    });

    const sink = [];
    const result = await dispatchQueued(db, { channel: deliveringChannel(sink) });

    assert.equal(result.failed, 1);
    assert.equal(result.sent, 1);
    assert.equal(sink.length, 1);
    assert.equal(sink[0].to, '9876500888', 'the second message still reached somebody');
  });

  test('dispatch is idempotent, a sent message is not resent', async () => {
    const donor = await seedDonor();
    await grantConsent(donor.id);
    await queueMessage({
      donorId: donor.id,
      to: '9876500777',
      subject: 'Blood needed: O-',
      body: 'A need for O negative nearby.',
    });

    await dispatchQueued(db, { channel: deliveringChannel([]) });

    const second = [];
    const result = await dispatchQueued(db, { channel: deliveringChannel(second) });

    // The point of the status column. Without it every poll resends every
    // message and a donor gets the same alert forty times.
    assert.equal(result.sent, 0);
    assert.equal(second.length, 0);
  });
});

describe('community messages carry the boundary statement', () => {
  test('the disclaimer is the first thing a donor reads', () => {
    // The message will be read on a phone and probably forwarded to a family
    // member. There is nowhere else the caveat will appear.
    return (async () => {
      const donor = await seedDonor();
      await grantConsent(donor.id);

      const request = await db.query(
        `INSERT INTO requests (id, blood_group, units, urgency, hospital, contact_phone)
         VALUES ('99999999-9999-9999-9999-999999999999', 'O-', 2, 'emergency', 'Apollo Hospital', '9876500123')
         RETURNING *`,
      );

      const plan = buildEscalationPlan(toRequestDomain(request[0]), {
        banks: [],
        donors: [toDonorPlanShape(donor, { consentedEmergency: true })],
        options: { tiers: [{ name: 'nearest', radiusKm: 50, limit: 10 }] },
      });

      const messages = buildCommunityMessages({
        plan,
        request: toRequestDomain(request[0]),
        donorsById: new Map([[donor.id, { ...donor, bloodGroup: donor.blood_group, phone: donor.phone }]]),
      });

      assert.equal(messages.length, 1);
      assert.match(messages[0].body, /^Student engineering project\./);
      assert.match(messages[0].body, /Not a blood bank/);
      assert.match(messages[0].body, /2 unit\(s\) of O- needed at Apollo Hospital/);
      assert.match(messages[0].body, /do not travel if you are unwell/i);
      // The contact number goes to a donor who can actually help, and nowhere else.
      assert.match(messages[0].body, /9876500123/);
    })();
  });

  test('a donor who cannot serve the group gets no message', () => {
    return (async () => {
      const wrongGroup = await seedDonor({ bloodGroup: 'A+' });
      await grantConsent(wrongGroup.id);

      const request = await db.query(
        `INSERT INTO requests (id, blood_group, units, urgency, hospital, contact_phone)
         VALUES ('88888888-8888-8888-8888-888888888888', 'O-', 1, 'emergency', 'Apollo', '9876500123')
         RETURNING *`,
      );

      const plan = buildEscalationPlan(toRequestDomain(request[0]), {
        banks: [],
        donors: [toDonorPlanShape(wrongGroup, { consentedEmergency: true })],
      });

      const messages = buildCommunityMessages({
        plan,
        request: toRequestDomain(request[0]),
        donorsById: new Map([[wrongGroup.id, { ...wrongGroup, bloodGroup: wrongGroup.blood_group, phone: wrongGroup.phone }]]),
      });

      assert.equal(messages.length, 0, 'an A positive donor cannot serve an O negative patient');
    })();
  });
});
