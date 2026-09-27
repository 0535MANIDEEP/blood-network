import { assertNoClinicalClaim } from '../policy/boundary.js';

/**
 * Notification channels.
 *
 * A donor community only exists if somebody actually hears about the need. Until
 * this file existed, notifications were written to a table and stopped there,
 * which is a database rather than a community.
 *
 * Every adapter takes the same shape, so the choice of channel is a deployment
 * decision rather than a code change, and so a new channel cannot accidentally
 * skip the consent check that all of them share.
 *
 * On the channels themselves: WhatsApp's official Cloud API is paid, requires
 * business verification and approved message templates, and enforces a 24 hour
 * conversation limit. That makes it the wrong dependency for a project that needs
 * to reach a donor at 11pm. So the default here is a plain webhook, which any SMS
 * gateway, Telegram bot or college-run relay can sit behind, plus a deep link
 * channel that needs no infrastructure at all.
 */

export class NotificationRefused extends Error {
  constructor(reason, detail) {
    super(detail ?? reason);
    this.name = 'NotificationRefused';
    this.reason = reason;
  }
}

export class ConsentRequired extends NotificationRefused {
  constructor() {
    super('no_consent', 'This subject has not consented to this channel and purpose.');
  }
}

export class BoundaryViolation extends NotificationRefused {
  constructor(detail) {
    super('boundary', detail);
  }
}

/**
 * A channel that records what it would send and sends nothing.
 *
 * Not a stub. This is the mode a real deployment should run in until somebody has
 * deliberately configured a gateway, because the alternative is a default that
 * starts sending the moment an environment variable is set.
 *
 * The dryRun flag matters to the dispatcher: a dry run must leave the queue
 * intact, so that exercising this path does not consume the messages a real
 * dispatch still has to deliver. Marking them handled would mean a test run
 * silently emptied a queue of real alerts.
 */
export function dryRunChannel(sink = []) {
  return {
    name: 'dry-run',
    sendsNothing: true,
    async send(message) {
      sink.push(message);
      return { delivered: false, dryRun: true, reason: 'dry_run' };
    },
  };
}

/**
 * Generic HTTP webhook. Put an SMS gateway, a Telegram bot API call or a
 * college relay behind this and it works without a code change.
 *
 * The recipient is posted as a string in the body rather than in the path, so a
 * phone number cannot end up in a proxy log or an access log by being part of a
 * URL. That is a small thing that costs nothing and is very hard to retrofit.
 */
export function webhookChannel({ url, token, timeoutMs = 8000, fetchImpl = fetch } = {}) {
  if (!url) {
    throw new Error('webhookChannel needs a url');
  }

  return {
    name: 'webhook',
    sendsNothing: false,
    async send(message) {
      if (!message.to) {
        throw new NotificationRefused('no_recipient', 'Message has no recipient.');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;

        const response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            to: message.to,
            channel: message.channel,
            subject: message.subject,
            body: message.body,
            // Passed through so a gateway can thread a reply back to the same
            // request without a second lookup.
            reference: message.reference ?? null,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          return { delivered: false, reason: `gateway_${response.status}` };
        }
        return { delivered: true };
      } catch (err) {
        // A gateway that is down is not an exception the caller should handle.
        // Returning a reason keeps one broken channel from taking down a dispatch
        // run for every other channel.
        return { delivered: false, reason: err.name === 'AbortError' ? 'timeout' : 'gateway_unreachable' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * A deep link the person taps themselves.
 *
 * Requires no gateway, no account and no cost, which makes it the only channel
 * guaranteed to work in a demonstration or a small community. It is also the
 * weakest, because it depends on the recipient reading it.
 */
export function deepLinkChannel({ baseUrl } = {}) {
  return {
    name: 'deep-link',
    sendsNothing: false,
    async send(message) {
      if (!message.to || !baseUrl) {
        return { delivered: false, reason: 'no_base_url' };
      }
      return {
        delivered: true,
        link: `${baseUrl}?r=${encodeURIComponent(message.reference ?? '')}`,
      };
    },
  };
}

/**
 * Build a message, refusing anything that makes a clinical claim.
 *
 * Every outbound message about blood passes through here. A notification that
 * says "sterile" or "transfusion ready" will be believed by somebody standing in
 * a corridor at 2am, and this project is not entitled to that claim. Failing the
 * send is the right outcome; the alternative is a message we cannot unsend.
 */
export function buildMessage({ to, channel, subject, body, reference }) {
  if (!to) throw new NotificationRefused('no_recipient', 'Message has no recipient.');
  if (!subject || !body) throw new NotificationRefused('incomplete', 'Message needs a subject and a body.');

  try {
    assertNoClinicalClaim(subject);
    assertNoClinicalClaim(body);
  } catch (err) {
    throw new BoundaryViolation(err.message);
  }

  return { to: String(to), channel, subject, body, reference: reference ?? null };
}
