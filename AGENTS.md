# Agent instructions (Codex / Antigravity / other coding assistants)

You are implementing and verifying a TypeScript npm library, `crashsafe-sync`, not creating a new framework.

Non-negotiable scope:
1. Atomic PostgreSQL transaction around destination page writes AND checkpoint advancement.
2. One worker per sync key using leases + fencing tokens; stale workers must never commit.
3. No hosted backend, no OAuth, no provider catalog, no scheduler, no cross-database transactions.
4. At-least-once page handling with caller-defined idempotent UPSERTs. Never claim exactly-once effects.
5. A clear, minimal, dependency-light public API that runs on Node 20+.

Before changing code:
- Read README.md, src/*.ts, sql/*.sql, tests/**/*.mjs.
- Run `npm install`, `npm test`, then `SYNC_TEST_DB_OK=yes DATABASE_URL=... npm run test:pg` using a disposable PostgreSQL database.
- Review node-postgres's 'same client per transaction' rule.

Quality bars before publishing:
- `npm run typecheck`, `npm test`, and real Postgres `npm run test:pg` green.
- Add tests for crashes during page commit, duplicate replay, two runners, expired leases, rate limits and invalid checkpoints.
- Check that every expected guarantee is true under tests, not merely documented.
- Verify Node 20 and 22+ compatibility.
- Inspect `npm pack --dry-run` for unintended files, especially secrets.
- Set the owner's actual npm scope and real GitHub repository URL; do not invent or reserve a name.
- Generate and commit package-lock.json with npm install once registry access is available.
- Do not publish without the user's authenticated explicit instruction.

When working on new features, start with a failing integration test that exercises the correctness invariant, implement the minimal change, and run the entire suite. Report evidence, commands and remaining risks truthfully.
