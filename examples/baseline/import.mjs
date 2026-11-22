// Standalone comparison using a session advisory lock and transactional checkpoint.
import pg from 'pg';
import pRetry, {AbortError} from 'p-retry';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
const client = await pool.connect();
const key = 'baseline:customers:v1';
try {
  const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [key]);
  if (!lock.rows[0].acquired) throw new Error('sync already running');
  await client.query(`CREATE TABLE IF NOT EXISTS baseline_checkpoint (
    sync_key text PRIMARY KEY, offset_value integer NOT NULL DEFAULT 0, completed boolean NOT NULL DEFAULT false)`);
  await client.query(`CREATE TABLE IF NOT EXISTS baseline_customers (
    external_id text PRIMARY KEY, name text NOT NULL)`);
  try {
    await client.query('INSERT INTO baseline_checkpoint(sync_key) VALUES ($1) ON CONFLICT DO NOTHING', [key]);
    let state = (await client.query('SELECT * FROM baseline_checkpoint WHERE sync_key=$1', [key])).rows[0];
    for (let pages = 0; pages < 2 && !state.completed; pages++) {
      const page = await pRetry(async () => {
        // Replace this deterministic source with a provider call.
        const offset = state.offset_value;
        if (offset < 0 || offset > 35) throw new AbortError(new Error('invalid checkpoint'));
        const records = Array.from({length: Math.min(10, 35 - offset)}, (_, i) => ({
          id: `customer_${offset + i + 1}`, name: `Customer ${offset + i + 1}`,
        }));
        return {records, offset: offset + records.length};
      }, {retries: 2, minTimeout: 200});
      await client.query('BEGIN');
      try {
        for (const record of page.records) {
          await client.query(`INSERT INTO baseline_customers VALUES ($1, $2)
            ON CONFLICT (external_id) DO UPDATE SET name=EXCLUDED.name`, [record.id, record.name]);
        }
        const result = await client.query(`UPDATE baseline_checkpoint SET offset_value=$2, completed=$3
          WHERE sync_key=$1 RETURNING *`, [key, page.offset, page.offset >= 35]);
        await client.query('COMMIT');
        state = result.rows[0];
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
    console.log(state);
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]).catch(() => {});
  }
} finally {
  client.release();
  await pool.end();
}
