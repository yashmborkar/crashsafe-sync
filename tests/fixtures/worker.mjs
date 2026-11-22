import pg from 'pg';
import {createSync} from '../../dist/index.js';
import {PgSyncStore} from '../../dist/postgres.js';

const pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
const key = process.env.TEST_SYNC_KEY;
const sync = createSync({
  key, store: new PgSyncStore(pool), leaseTtlMs: 500, heartbeatIntervalMs: 100,
  async fetchPage({checkpoint}) {
    const next = (checkpoint?.offset ?? 0) + 1;
    return {records: [next], nextCheckpoint: {offset: next}, done: next === 2};
  },
  async writeBatch({tx, records}) {
    await tx.query(`INSERT INTO crashsafe_sync_test_records VALUES ($1, $2, 'worker')
      ON CONFLICT(sync_key, external_id) DO UPDATE SET payload=EXCLUDED.payload`, [key, records[0]]);
    if (process.env.INTERRUPT_WORKER === 'yes' && records[0] === 2) {
      process.send('writing');
      await new Promise(() => {});
    }
  },
});
try {
  const result = await sync.run();
  process.send({status: result.status, checkpoint: result.state.checkpoint});
} finally {
  await pool.end();
  process.disconnect();
}
