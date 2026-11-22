import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSync, HttpResponseError, CheckpointInvalidError, InvalidPageError, retryFetch } from '../../dist/index.js';
import { MemorySyncStore } from '../../dist/memory.js';

const fixture = Array.from({length: 31}, (_, i) => ({ id: i + 1 }));
const make = (store, sink, overrides = {}) => createSync({
  key: 'users',
  store,
  fetchPage: async ({ checkpoint }) => {
    const start = checkpoint?.offset ?? 0;
    const records = fixture.slice(start, start + 10);
    return { records, nextCheckpoint: { offset: start + records.length }, done: start + records.length >= fixture.length };
  },
  writeBatch: async ({ records }) => { for (const record of records) sink.set(record.id, record); },
  ...overrides,
});

test('multi-run pagination persists checkpoint and completes', async () => {
  const store = new MemorySyncStore();
  const sink = new Map();
  const sync = make(store, sink);
  const first = await sync.run({ maxPages: 2 });
  assert.equal(first.status, 'paused');
  assert.deepEqual(first.state.checkpoint, {offset: 20});
  assert.equal(sink.size, 20);
  const second = await sync.run();
  assert.equal(second.status, 'completed');
  assert.equal(sink.size, 31);
  assert.equal(second.state.pagesCommitted, 4);
  const third = await sync.run();
  assert.equal(third.pagesProcessed, 0);
  assert.equal(third.status, 'completed');
});

test('failed write leaves checkpoint unadvanced; a new run retries the page', async () => {
  const store = new MemorySyncStore();
  const sink = new Map();
  let fails = true;
  const sync = make(store, sink, {
    writeBatch: async ({ records }) => {
      if (fails) { fails = false; throw new Error('forced crash before commit'); }
      for (const record of records) sink.set(record.id, record);
    },
  });
  await assert.rejects(sync.run(), /forced crash/);
  assert.equal((await sync.readState()).pagesCommitted, 0);
  const next = await sync.run();
  assert.equal(next.status, 'completed');
  assert.equal(sink.size, fixture.length);
});

test('second runner reports busy if first owns the active lease', async () => {
  const store = new MemorySyncStore();
  const sink = new Map();
  let releaseFetch;
  let fetchStarted;
  const started = new Promise(resolve => {fetchStarted = resolve;});
  const gate = new Promise(resolve => {releaseFetch = resolve;});
  const sync = make(store, sink, {
    fetchPage: async () => {
      fetchStarted();
      await gate;
      return {records: [], nextCheckpoint: null, done: true};
    },
  });
  const first = sync.run();
  await started;
  const second = await sync.run();
  assert.equal(second.status, 'busy');
  releaseFetch();
  assert.equal((await first).status, 'completed');
});

test('lease fencing rejects late commits from a stale runner', async () => {
  const store = new MemorySyncStore();
  const stale = (await store.acquire('stream', 15)).lease;
  await new Promise(resolve => setTimeout(resolve, 24));
  const fresh = (await store.acquire('stream', 1000)).lease;
  await assert.rejects(() => store.commitPage({
    lease: stale, nextCheckpoint: {offset: 1}, completed: false, recordCount: 1,
    write: async () => {throw new Error('must not execute');},
  }), {name: 'LeaseLostError'});
  assert.equal((await store.read('stream')).pagesCommitted, 0);
  await store.release(fresh);
});

test('retries 429 and does not persist state before fetch succeeds', async () => {
  const store = new MemorySyncStore();
  let calls = 0;
  const sync = make(store, new Map(), {
    retry: {attempts: 3, baseDelayMs: 1},
    fetchPage: async () => {
      calls++;
      if (calls < 3) {
        assert.equal((await store.read('users')).pagesCommitted, 0);
        throw new HttpResponseError(429, 'rate limited', 1);
      }
      return {records: [{id: 1}], nextCheckpoint: null, done: true};
    },
  });
  assert.equal((await sync.run()).status, 'completed');
  assert.equal(calls, 3);
});

test('checkpoint invalidity is surfaced, never silently reset', async () => {
  const store = new MemorySyncStore();
  const sync = make(store, new Map(), {
    fetchPage: async () => { throw new CheckpointInvalidError('cursor expired', 'full-resync'); },
  });
  await assert.rejects(sync.run(), error => error instanceof CheckpointInvalidError && error.recovery === 'full-resync');
  assert.equal((await sync.readState()).pagesCommitted, 0);
});

test('rejects nonadvancing checkpoint instead of looping forever', async () => {
  const sync = make(new MemorySyncStore(), new Map(), {
    fetchPage: async () => ({records: [], nextCheckpoint: null, done: false}),
  });
  await assert.rejects(sync.run(), InvalidPageError);
});

test('nonretryable fetch errors stop immediately', async () => {
  let attempts = 0;
  await assert.rejects(retryFetch(async () => {
    attempts++;
    throw new HttpResponseError(401, 'unauthorized');
  }, new AbortController().signal, {attempts: 9, baseDelayMs: 1}), /unauthorized/);
  assert.equal(attempts, 1);
});

test('abort stops processing without advancing an unfetched page', async () => {
  const aborter = new AbortController();
  const store = new MemorySyncStore();
  const sync = make(store, new Map(), {
    fetchPage: async ({signal}) => {
      aborter.abort();
      assert.equal(signal.aborted, true);
      return {records: [{id: 1}], nextCheckpoint: null, done: true};
    },
  });
  await assert.rejects(sync.run({signal: aborter.signal}), {name:'AbortSyncError'});
  assert.equal((await sync.readState()).pagesCommitted, 0);
});


test('destructured run method works and reports busy', async () => {
  const store = new MemorySyncStore();
  const held = await store.acquire('users', 5000);
  const {run} = make(store, new Map());
  const result = await run();
  assert.equal(result.status, 'busy');
  assert.equal(result.state.key, 'users');
  await store.release(held.lease);
});

test('telemetry failure does not undo a committed checkpoint', async () => {
  const store = new MemorySyncStore();
  const sync = make(store, new Map(), {
    onProgress: () => { throw new Error('telemetry offline'); },
  });
  const result = await sync.run({maxPages: 1});
  assert.equal(result.status, 'paused');
  assert.equal((await sync.readState()).pagesCommitted, 1);
});
