import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Database access.
 *
 * Two backends behind one interface:
 *
 *   PGlite  PostgreSQL compiled to WASM, running in process. Real PostgreSQL
 *           semantics, real constraint enforcement, real transactions. Used for
 *           development and for the test suite, so the safety properties are
 *           proven against the actual engine rather than a mock.
 *
 *   pgPool  A normal connection pool for production, same SQL either way.
 *
 * The point of not mocking: the guarantee that inventory can never go negative
 * is enforced by a CHECK constraint and a row lock. A mock proves nothing about
 * either.
 */

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/** Normalises both backends to { rows }. */
async function run(db, sql, params = []) {
  if (typeof db.query === 'function') {
    const result = await db.query(sql, params);
    return result.rows;
  }
  return (await db.exec(sql, params)).rows;
}

export async function createDatabase({ url, dataDir } = {}) {
  if (url) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: url, max: 10 });
    return {
      kind: 'pg',
      query: (sql, params) => run(pool, sql, params),
      exec: (sql) => pool.query(sql).then((r) => r.rows),
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const value = await fn({ query: (sql, params) => run(client, sql, params) });
          await client.query('COMMIT');
          return value;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }

  const pglite = await PGlite.create(dataDir ? { dataDir } : undefined);
  return {
    kind: 'pglite',
    query: (sql, params) => run(pglite, sql, params),
    // exec must use PGlite's own exec, not query. query is a prepared statement
    // and refuses multi command scripts, which is exactly what migrate and reset
    // need to send.
    exec: (sql) => pglite.exec(sql),
    transaction: async (fn) => {
      // PGlite is single connection, so a transaction is inherently serialised
      // here. That is a real limitation of the in-process backend, not a
      // property of the design: the row level locking below is what protects a
      // pooled production database, and the constraint protects both.
      await pglite.exec('BEGIN');
      try {
        const value = await fn({ query: (sql, params) => run(pglite, sql, params) });
        await pglite.exec('COMMIT');
        return value;
      } catch (err) {
        await pglite.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => pglite.close(),
  };
}

export async function migrate(db) {
  const sql = await fs.readFile(SCHEMA_PATH, 'utf8');
  await db.exec(sql);
  return { migrated: true, schema: SCHEMA_PATH };
}

/** Clears every table. Test only. */
export async function reset(db) {
  await db.exec(`
    TRUNCATE password_resets, sessions, users, notifications, consents, reservations,
             request_replies, requests, inventory, donors, banks
    RESTART IDENTITY CASCADE
  `);
}
