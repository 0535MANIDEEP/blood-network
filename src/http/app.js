import express from 'express';
import cors from 'cors';

import { attachSession, errorHandler, notFoundHandler } from './middleware.js';
import { requestLimiter } from './rate-limit.js';
import { authRoutes } from './routes/auth.js';
import { requestRoutes } from './routes/requests.js';
import { donorRoutes } from './routes/donor.js';
import { bankRoutes } from './routes/bank.js';
import { coordinatorRoutes } from './routes/coordinator.js';
import { requiredDisclaimer } from '../policy/boundary.js';

/**
 * Application assembly.
 *
 * Exported as a factory that does not listen, so the test suite can drive the
 * real app over a real socket rather than importing handlers and calling them
 * directly. That distinction catches things a direct call cannot: middleware that
 * only runs on a mounted path, a cookie that is not actually set, a 404 that
 * never fires because the router claims everything.
 */

/**
 * Minimal security headers, hand rolled rather than pulled from a dependency.
 *
 * The set is short on purpose. Content-Security-Policy is deliberately not set
 * here, because a wrong CSP breaks a working app in a way that is hard to
 * diagnose, and an API that returns JSON has far less to protect than a document
 * that renders HTML. The API should sit behind a host that sets CSP for the
 * front end.
 */
function securityHeaders(_req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.removeHeader('X-Powered-By');
  next();
}

/**
 * CORS with an explicit origin allowlist.
 *
 * `cors({ origin: true })` reflects whatever Origin the caller sent while also
 * allowing credentials, which means any website the user visits can make
 * authenticated requests to this API and read the responses. That is the whole
 * attack, and it needs nothing but a page on a domain somebody owns. So origins
 * are listed, and an unknown one is refused rather than reflected.
 */
function corsFor({ allowedOrigins = [], allowCredentials = true } = {}) {
  const allowlist = new Set(allowedOrigins.filter(Boolean));

  return cors({
    origin(origin, callback) {
      // Same origin and server to server requests send no Origin header. Absent
      // is not the same as untrusted, so it is allowed.
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowlist.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: allowCredentials,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    // Needed by the browser to read Retry-After on a 429.
    exposedHeaders: ['Retry-After', 'X-RateLimit-Remaining'],
    maxAge: 600,
  });
}

export function createApp({ db, options = {}, logger = console } = {}) {
  const {
    allowedOrigins = [],
    secureCookies = true,
    throttle,
    passwordCost,
    expiry,
    idleMinutes,
    publicRateLimit = { limit: 30, windowMs: 60_000 },
  } = options;

  const app = express();

  // Behind a proxy, req.ip is the proxy's address unless this is set, and every
  // rate limit would then be shared by the entire internet. Trust exactly one
  // hop, because trusting more lets a caller forge the header the limiter reads.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(securityHeaders);
  app.use(corsFor({ allowedOrigins }));

  // A small hard cap. A request body here is a phone number and a hospital name.
  // Anything past 16kb is not a real request, and an unbounded parser is the
  // cheapest denial of service there is.
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', async (_req, res) => {
    let database = 'unknown';
    try {
      await db.query('SELECT 1');
      database = 'ok';
    } catch {
      database = 'unavailable';
    }
    res.json({
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      disclaimer: requiredDisclaimer(),
    });
  });

  /**
   * What this is, in one call. The boundary is not a footer and not a README
   * paragraph, it is the first thing a client should be able to read and hold
   * this project to.
   */
  app.get('/api/about', (_req, res) => {
    res.json({
      project: 'Blood Network',
      whatItIs: 'A directory and notification layer over licensed blood banks.',
      whatItIsNot: [
        'Not a blood bank.',
        'Not a medical device.',
        'Not a transfusion service.',
        'Not a clinical decision support tool.',
      ],
      disclaimer: requiredDisclaimer(),
    });
  });

  app.use('/api', attachSession({ db, idleMinutes }));

  app.use(
    '/api/auth',
    authRoutes({ db, throttle, secureCookies, passwordCost, expiry }),
  );

  app.use(
    '/api/requests',
    requestRoutes({
      db,
      // Raising a request is unauthenticated by design, so this is the only
      // thing standing between a public write endpoint and a spam relay.
      rateLimiter: requestLimiter(publicRateLimit),
    }),
  );

  app.use('/api/donor', donorRoutes({ db }));
  app.use('/api/bank', bankRoutes({ db }));
  app.use('/api/coordinator', coordinatorRoutes({ db }));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
