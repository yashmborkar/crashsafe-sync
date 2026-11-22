/** Run: DATABASE_URL=postgres://... node examples/local-import.mjs
 * First apply sql/001_create_sync_state.sql and examples/example_records.sql.
 * The fetchPage callback is a deterministic mock provider; replace with any SDK.
 */
import pg from 'pg';
import { createSync, HttpResponseError } from '../dist/index.js';
import { PgSyncStore } from '../dist/postgres.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
const sync = createSync({
  key: 'demo:customers:v1',
  store: new PgSyncStore(pool),
  retry: {attempts: 3, baseDelayMs: 200},
  async fetchPage({checkpoint, signal}) {
    const offset = checkpoint?.offset ?? 0;
    // Replace this with fetch('https://provider.example/...', {signal}) or an SDK.
    if (signal.aborted) throw new Error('Aborted');
    const records = Array.from({length: Math.min(10, 35-offset)}, (_,i) => ({
      externalId: `customer_${offset+i+1}`, name: `Customer ${offset+i+1}`,
    }));
    if (offset === 10 && process.env.SIMULATE_429 === '1' && !globalThis._once) {
      globalThis._once = true;
      throw new HttpResponseError(429, 'upstream limited request', 400);
    }
    return {
      records,
      nextCheckpoint: {offset: offset + records.length},
      done: offset + records.length >= 35,
    };
  },
  async writeBatch({tx, records}) {
    for (const record of records) {
      await tx.query(`INSERT INTO example_customers(external_id, name) VALUES($1,$2)
        ON CONFLICT (external_id) DO UPDATE SET name=EXCLUDED.name`,
      [record.externalId, record.name]);
    }
  },
  onProgress(state) {console.log('Committed', state.pagesCommitted, 'pages;', state.recordsCommitted, 'records');},
});

try {
  const outcome = await sync.run({maxPages: 2});
  console.log(outcome);
  if (outcome.status === 'paused') console.log('Run this script again to finish the import.');
} finally {
  await pool.end();
}
