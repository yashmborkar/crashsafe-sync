# Baseline comparison

`examples/baseline/import.mjs` uses `pg`, `p-retry`, a session advisory lock, a checkpoint table, and one transaction per page. Run it twice with `DATABASE_URL` set to a disposable database after `npm install`. It creates its two tables. The library example needs the supplied state and destination migrations. Both examples process at most two pages per invocation.

The baseline is 51 physical lines and the library example is 48 (`wc -l`, including blank lines and comments). These counts exclude library implementation, schemas, and tests. The three-line difference is not evidence of a meaningful complexity reduction. The baseline requires application-owned locking, checkpoint persistence, transaction management and retry policy. The library centralizes those responsibilities and adds leases, fencing, heartbeats and configurable retry handling. The baseline uses one connection for its whole run and holds an advisory lock until it releases the lock or the database detects disconnection.

| Scenario | Library | Baseline |
| --- | --- | --- |
| Kill during destination write, rollback and restart | Tested with SIGKILL after one committed page | Tested with SIGKILL on first page |
| Competing workers | Tested using independent pools | Tested with concurrent processes and advisory lock |
| SQL error rolls back writes and checkpoint | Tested with unique constraint error | Tested with a trigger error after one write |
| Replay with UPSERT | Tested | Tested by resetting cursor and replaying |
| Invalid checkpoint | Tested after committed progress | Tested with invalid stored offset |
| HTTP 429, progress during retry | Tested | p-retry present, sample has no 429 or Retry-After policy |
| Expired lease, takeover and stale fencing | Tested | Not applicable to the session lock |
| Connection loss mid-transaction | Tested with backend termination | Process kill tested; network loss not independently tested |

Run `SYNC_TEST_DB_OK=yes DATABASE_URL=... npm run test:pg` against a disposable database to reproduce. Baseline and library tests use distinct tables. This matrix describes these tests and does not establish general equivalence between locking models or provider implementations.
