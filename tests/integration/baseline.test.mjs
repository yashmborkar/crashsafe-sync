import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import pg from 'pg';

assert.equal(process.env.SYNC_TEST_DB_OK, 'yes');
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
const run = () => spawn(process.execPath, ['examples/baseline/import.mjs'], {
  env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
});
const finished = child => new Promise((resolve, reject) => {
  let output = '';
  child.stdout.on('data', chunk => {output += chunk;});
  child.stderr.on('data', chunk => {output += chunk;});
  child.on('error', reject);
  child.on('close', (code, signal) => resolve({code, signal, output}));
});

test('baseline interruption, lock exclusion, rollback, resume and replay', async () => {
  await pool.query('DROP TABLE IF EXISTS baseline_customers, baseline_checkpoint');
  await pool.query(`CREATE TABLE baseline_checkpoint (sync_key text PRIMARY KEY, offset_value integer NOT NULL DEFAULT 0, completed boolean NOT NULL DEFAULT false)`);
  await pool.query('CREATE TABLE baseline_customers (external_id text PRIMARY KEY, name text NOT NULL)');
  await pool.query(`CREATE OR REPLACE FUNCTION pg_temp_placeholder() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(10); RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER baseline_test_delay BEFORE INSERT ON baseline_customers FOR EACH ROW EXECUTE FUNCTION pg_temp_placeholder()');
  const first = run();
  const firstDone = finished(first);
  try {
    let active = false;
    for (let i = 0; i < 100 && !active; i++) {
      const result = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE 'INSERT INTO baseline_customers VALUES%' AND state = 'active'");
      active = result.rows[0].n > 0;
      if (!active) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(active, 'baseline reached destination write');
    const competitor = await finished(run());
    assert.notEqual(competitor.code, 0);
    assert.match(competitor.output, /sync already running/);
    first.kill('SIGKILL');
    assert.equal((await firstDone).signal, 'SIGKILL');
    await pool.query('DROP TRIGGER baseline_test_delay ON baseline_customers');
    await pool.query('DROP FUNCTION pg_temp_placeholder()');
    const checkpoint = await pool.query("SELECT offset_value FROM baseline_checkpoint WHERE sync_key='baseline:customers:v1'");
    assert.equal(checkpoint.rows[0].offset_value, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM baseline_customers')).rows[0].n, 0);
    const resumed = await finished(run());
    assert.equal(resumed.code, 0, resumed.output);
    assert.match(resumed.output, /offset_value: 20/);
    const completed = await finished(run());
    assert.equal(completed.code, 0, completed.output);
    assert.match(completed.output, /offset_value: 35/);
    await pool.query("UPDATE baseline_checkpoint SET offset_value=0, completed=false WHERE sync_key='baseline:customers:v1'");
    assert.equal((await finished(run())).code, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM baseline_customers')).rows[0].n, 35);
    await pool.query("UPDATE baseline_checkpoint SET offset_value=-1, completed=false WHERE sync_key='baseline:customers:v1'");
    const invalid = await finished(run());
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.output, /invalid checkpoint/);
    assert.equal((await pool.query("SELECT offset_value FROM baseline_checkpoint WHERE sync_key='baseline:customers:v1'")).rows[0].offset_value, -1);
  } finally {
    if (first.exitCode === null && first.signalCode === null) first.kill('SIGKILL');
    await pool.query('DROP TRIGGER IF EXISTS baseline_test_delay ON baseline_customers');
    await pool.query('DROP FUNCTION IF EXISTS pg_temp_placeholder()');
    await pool.end();
  }
});
