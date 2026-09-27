import 'dotenv/config';

import { createDatabase, migrate } from './client.js';

/**
 * Schema migration. Separate from the server so it can run in a deploy step, and
 * so a failed migration never happens half way through booting a listener.
 *
 * schema.sql is written to be idempotent, so running it repeatedly is safe.
 */

const db = await createDatabase({
  url: process.env.DATABASE_URL,
  dataDir: process.env.DATABASE_URL ? undefined : (process.env.PGLITE_DIR ?? './.pgdata'),
});

const result = await migrate(db);
console.log(`[migrate] applied ${result.schema} to ${db.kind}`);

await db.close();
