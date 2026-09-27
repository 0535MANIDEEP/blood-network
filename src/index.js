import 'dotenv/config';

import { createDatabase, migrate } from './db/client.js';
import { createApp } from './http/app.js';
import { assertPolicyReviewed, REGULATORY_POLICY } from './policy/regulatory.js';
import { enforceBoundary, requiredDisclaimer } from './policy/boundary.js';

/**
 * Entry point.
 *
 * The order of the checks at the top is the point of this file. The boundary and
 * the policy review run BEFORE a database is opened or a port is bound, so a
 * deployment that should not exist fails in about a second with a readable
 * reason, rather than half starting and serving requests against an unverified
 * rule set.
 *
 * Run it with nothing configured and you get a working local instance on PGlite.
 * Point DATABASE_URL at a server and the same code runs on a real pool.
 */

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

// ---- Refusals, before anything is opened -------------------------------------

assertPolicyReviewed({ isProduction });

const boundary = enforceBoundary({
  isProduction,
  env,
  policyReviewed: REGULATORY_POLICY.reviewed,
  seedMode: env.SEED_MODE !== 'false',
  notifyRecipients: env.NOTIFY_RECIPIENTS ?? 'fixtures',
});

if (!boundary.withinBoundary && !boundary.override) {
  // enforceBoundary throws, so reaching here means the override was used. Say so
  // out loud at boot rather than letting it be discovered later.
  console.warn('[boundary] ALLOW_REAL_DATA override is active. This deployment is NOT a student project boundary.');
}

// ---- Wiring ------------------------------------------------------------------

const PORT = Number(env.PORT ?? 4000);

const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const db = await createDatabase({
  url: env.DATABASE_URL,
  dataDir: env.DATABASE_URL ? undefined : (env.PGLITE_DIR ?? './.pgdata'),
});

await migrate(db);

const app = createApp({
  db,
  options: {
    allowedOrigins,
    // Secure cookies are dropped by a browser over plain http, so a local http
    // run would silently lose every session. Turned off only when explicitly
    // asked, never by default.
    secureCookies: env.SECURE_COOKIES !== 'false',
    publicRateLimit: {
      limit: Number(env.PUBLIC_RATE_LIMIT ?? 30),
      windowMs: Number(env.PUBLIC_RATE_WINDOW_MS ?? 60_000),
    },
  },
});

const server = app.listen(PORT, () => {
  console.log(`[blood-network] listening on http://localhost:${PORT}`);
  console.log(`[blood-network] origins allowed: ${allowedOrigins.length ? allowedOrigins.join(', ') : 'none (same origin only)'}`);
  console.log(`[blood-network] database: ${db.kind}`);
  console.log(`[blood-network] ${requiredDisclaimer()}`);
});

const shutdown = async (signal) => {
  console.log(`\n[${signal}] shutting down`);
  server.close();
  await db.close();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
