/**
 * Real PostgreSQL tests. MUST run only against an isolated, disposable test DB.
 * Usage: DATABASE_URL=postgres://... SYNC_TEST_DB_OK=yes npm run test:pg
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createSync, HttpResponseError, LeaseLostError } from '../../dist/index.js';
import { PgSyncStore } from '../../dist/postgres.js';

assert.equal(process.env.SYNC_TEST_DB_OK, 'yes', 'Refusing integration tests without SYNC_TEST_DB_OK=yes (requires disposable DB)');
assert.ok(process.env.DATABASE_URL, 'Set DATABASE_URL to your disposable PostgreSQL database');
const { default: pg } = await import('pg');
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 20});
after(async () => {await pool.end();});
const migration = await readFile(new URL('../../sql/001_create_sync_state.sql', import.meta.url), 'utf8');
await pool.query(migration);
await pool.query(`CREATE TABLE IF NOT EXISTS crashsafe_sync_test_records (
  sync_key text NOT NULL, external_id integer NOT NULL, payload text NOT NULL,
  PRIMARY KEY(sync_key, external_id)
)`);
const prefix = `it_${randomUUID().replaceAll('-', '')}`;
const key = (name) => `${prefix}_${name}`;
const store = new PgSyncStore(pool);

const pageSource = Array.from({length: 50}, (_, i) => ({id: i + 1, payload: `value-${i + 1}`}));
function makeEngine(syncKey, fault = {}) {
  let requests = 0;
  return createSync({
    key: syncKey, store, leaseTtlMs: 3000, heartbeatIntervalMs: 500,
    retry: {attempts: 3, baseDelayMs: 1},
    fetchPage: async ({checkpoint}) => {
      requests++;
      if (fault.rateLimit && requests === 1) throw new HttpResponseError(429, 'try later', 1);
      if (fault.slowFetch) await new Promise(resolve => setTimeout(resolve, 45));
      const offset = checkpoint?.offset ?? 0;
      const records = pageSource.slice(offset, offset + 10);
      return {records, nextCheckpoint: {offset: offset + records.length}, done: offset + records.length >= pageSource.length};
    },
    writeBatch: async ({tx, records}) => {
      for (const record of records) {
        await tx.query(`INSERT INTO crashsafe_sync_test_records (sync_key, external_id, payload)
          VALUES ($1, $2, $3) ON CONFLICT(sync_key, external_id)
          DO UPDATE SET payload = EXCLUDED.payload`, [syncKey, record.id, record.payload]);
      }
      if (fault.failOnce) {
        fault.failOnce = false;
        throw new Error('inject failure mid-transaction');
      }
    },
  });
}

async function count(syncKey) {
  const result = await pool.query('SELECT count(*)::int AS n FROM crashsafe_sync_test_records WHERE sync_key=$1', [syncKey]);
  return result.rows[0].n;
}

test('atomic rollback: failed business writes cannot advance checkpoint', async () => {
  const syncKey = key('rollback');
  const fault = {failOnce: true};
  const engine = makeEngine(syncKey, fault);
  await assert.rejects(engine.run(), /inject failure/);
  assert.equal(await count(syncKey), 0);
  assert.equal((await engine.readState()).pagesCommitted, 0);
  const complete = await engine.run();
  assert.equal(complete.status, 'completed');
  assert.equal(await count(syncKey), 50);
  assert.equal(complete.state.pagesCommitted, 5);
});

test('committed checkpoints resume in a fresh instance after a bounded run', async () => {
  const syncKey = key('resume');
  const engine1 = makeEngine(syncKey);
  const first = await engine1.run({maxPages: 2});
  assert.equal(first.status, 'paused');
  assert.equal(await count(syncKey), 20);
  assert.deepEqual(first.state.checkpoint, {offset: 20});
  const engine2 = makeEngine(syncKey);
  const resumed = await engine2.run();
  assert.equal(resumed.status, 'completed');
  assert.equal(await count(syncKey), 50);
  assert.equal(resumed.state.pagesCommitted, 5);
});

test('overlapping workers cannot both process same sync key', async () => {
  const syncKey = key('concurrent');
  const a = makeEngine(syncKey, {slowFetch: true});
  const b = makeEngine(syncKey, {slowFetch: true});
  const [r1,r2] = await Promise.all([a.run(),b.run()]);
  assert.deepEqual([r1.status,r2.status].sort(), ['busy','completed']);
  assert.equal(await count(syncKey), 50);
  assert.equal((await store.read(syncKey)).pagesCommitted, 5);
});

test('stale owner cannot write or advance after lease expires and is reclaimed', async () => {
  const syncKey = key('fencing');
  const stale = (await store.acquire(syncKey, 25)).lease;
  await new Promise(resolve => setTimeout(resolve, 75));
  const fresh = (await store.acquire(syncKey, 2000)).lease;
  await assert.rejects(store.commitPage({
    lease: stale, nextCheckpoint: {offset: 10}, completed: false, recordCount: 1,
    write: tx => tx.query(`INSERT INTO crashsafe_sync_test_records VALUES($1, 1, 'BAD')`,[syncKey]),
  }), LeaseLostError);
  assert.equal(await count(syncKey), 0);
  assert.equal((await store.read(syncKey)).pagesCommitted, 0);
  await store.release(fresh);
});

test('retryable provider 429 keeps checkpoint safe until fetch succeeds', async () => {
  const syncKey = key('ratelimit');
  const result = await makeEngine(syncKey, {rateLimit:true}).run({maxPages: 1});
  assert.equal(result.state.pagesCommitted, 1);
  assert.equal(await count(syncKey), 10);
});

test('expired lease during writes rolls back before a separate worker takes over', async () => {
  const syncKey = key('expire_during_write');
  const firstPool = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 1});
  const secondPool = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 1});
  const firstStore = new PgSyncStore(firstPool);
  const secondStore = new PgSyncStore(secondPool);
  try {
    const stale = (await firstStore.acquire(syncKey, 150)).lease;
    let started;
    const writing = new Promise(resolve => { started = resolve; });
    const first = firstStore.commitPage({lease: stale, nextCheckpoint: {offset: 1}, completed: false, recordCount: 1,
      write: async tx => {
        await tx.query('INSERT INTO crashsafe_sync_test_records VALUES ($1, 1, $2)', [syncKey, 'stale']);
        started();
        await new Promise(resolve => setTimeout(resolve, 250));
      }});
    await writing;
    await new Promise(resolve => setTimeout(resolve, 180));
    const takeover = secondStore.acquire(syncKey, 2000);
    await assert.rejects(first, LeaseLostError);
    const fresh = await takeover;
    assert.ok(fresh);
    assert.equal(await count(syncKey), 0);
    assert.equal((await secondStore.read(syncKey)).pagesCommitted, 0);
    await secondStore.commitPage({lease: fresh.lease, nextCheckpoint: {offset: 1}, completed: false, recordCount: 1,
      write: tx => tx.query('INSERT INTO crashsafe_sync_test_records VALUES ($1, 1, $2)', [syncKey, 'fresh'])});
    await assert.rejects(firstStore.commitPage({lease: stale, nextCheckpoint: null, completed: true, recordCount: 0, write: async () => {}}), LeaseLostError);
    assert.equal(await count(syncKey), 1);
    await secondStore.release(fresh.lease);
  } finally {
    await firstPool.end();
    await secondPool.end();
  }
});

test('database error after a write rolls back both records and checkpoint', async () => {
  const syncKey = key('sql_error');
  const lease = (await store.acquire(syncKey, 5000)).lease;
  await assert.rejects(store.commitPage({lease, nextCheckpoint: {offset: 1}, completed: false, recordCount: 1,
    write: async tx => {
      await tx.query('INSERT INTO crashsafe_sync_test_records VALUES ($1, 1, $2)', [syncKey, 'first']);
      await tx.query('INSERT INTO crashsafe_sync_test_records VALUES ($1, 1, $2)', [syncKey, 'duplicate']);
    }}), {code: '23505'});
  assert.equal(await count(syncKey), 0);
  assert.equal((await store.read(syncKey)).pagesCommitted, 0);
  await store.release(lease);
});

test('replayed page uses idempotent upserts', async () => {
  const syncKey = key('replay');
  const lease = (await store.acquire(syncKey, 5000)).lease;
  const write = tx => tx.query(`INSERT INTO crashsafe_sync_test_records VALUES ($1, 1, 'value')
    ON CONFLICT (sync_key, external_id) DO UPDATE SET payload = EXCLUDED.payload`, [syncKey]);
  for (let i = 0; i < 2; i++) {
    await store.commitPage({lease, nextCheckpoint: {offset: 1}, completed: false, recordCount: 1, write});
  }
  assert.equal(await count(syncKey), 1);
  await store.release(lease);
});

test('429 retry observes unchanged checkpoint before success', async () => {
  const syncKey = key('retry_progress');
  let calls = 0;
  const engine = createSync({key: syncKey, store, retry: {attempts: 2, baseDelayMs: 1},
    fetchPage: async () => {
      calls++;
      assert.equal((await store.read(syncKey)).pagesCommitted, 0);
      if (calls === 1) throw new HttpResponseError(429, 'limited', 1);
      return {records: [], nextCheckpoint: null, done: true};
    }, writeBatch: async () => {}});
  assert.equal((await engine.run()).status, 'completed');
  assert.equal(calls, 2);
});

test('terminated database connection rolls back an interrupted page', async () => {
  const syncKey = key('connection_terminated');
  const isolated = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 1});
  isolated.on('error', () => {});
  const isolatedStore = new PgSyncStore(isolated);
  try {
    const lease = (await isolatedStore.acquire(syncKey, 300)).lease;
    await assert.rejects(isolatedStore.commitPage({lease, nextCheckpoint: {offset: 1}, completed: false, recordCount: 1,
      write: async tx => {
        await tx.query('INSERT INTO crashsafe_sync_test_records VALUES ($1, 1, $2)', [syncKey, 'interrupted']);
        const pid = (await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const activeQuery = tx.query('SELECT pg_sleep(5)');
        void activeQuery.catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 30));
        await pool.query('SELECT pg_terminate_backend($1)', [pid]);
        await activeQuery;
      }}));
    assert.equal(await count(syncKey), 0);
    assert.equal((await store.read(syncKey)).pagesCommitted, 0);
    await new Promise(resolve => setTimeout(resolve, 350));
    const replacement = await store.acquire(syncKey, 2000);
    assert.ok(replacement);
    await store.release(replacement.lease);
  } finally {
    await isolated.end();
  }
});
