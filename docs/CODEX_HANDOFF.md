# Copy/paste task for Codex / Antigravity

You are an autonomous senior TypeScript/PostgreSQL library engineer. The repository is `crashsafe-sync`. Read `AGENTS.md`, `README.md`, source and tests first.

**Mission:** Bring this v0.1.0 preview to a verified npm beta release, not just a demo. Prioritize correctness over feature count. This repo already includes a compiling TypeScript core, PostgreSQL implementation, migrations, unit tests, integration tests, example and CI. Do not rebuild it from scratch.

Follow this sequence:

1. Run `npm install` and commit package-lock.json. Check TypeScript, package exports, ESM imports, Node 20+ compatibility and `npm pack --dry-run`.
2. Start disposable PostgreSQL (Docker `postgres:16` or local server). Set `SYNC_TEST_DB_OK=yes` and `DATABASE_URL`, then execute `npm run test:pg`. Repair any failures using a failing test first.
3. Add adversarial real-DB tests: use at least two separate pooled clients for two concurrent workers; inject errors after some destination writes before checkpoint update; simulate process termination or lease expiration; verify a stale worker cannot commit; enforce a provider rate-limit retry without advancing progress.
4. Check SQL and transactions for race conditions, lease heartbeats, network failures, `clock_timestamp()` vs transaction start timestamps, stalled/faulty handlers and rollback correctness. Avoid claiming exactly-once effects.
5. Build a *competent* baseline using `pg`, `p-retry`, and explicit transactional checkpoint state. Compare setup steps, integration LOC and correctness test matrix with the library. Document measurements without inventing numbers.
6. Run the runnable example twice and verify it resumes from its committed cursor, with no duplicate destination IDs.
7. Run `npm test`, `npm run test:pg`, `npm run typecheck`, `npm run pack:check` and report exact outputs.
8. Improve README quickstart, API reference and failure-semantics docs only after correctness tests are green.
9. Ask the user for their desired npm name/scope and repository URL before modifying `package.json` metadata. Verify availability with `npm view` and set `repository` to the actual repo.
10. Prepare an npm `0.1.0` beta published by the user's authenticated npm account. Prefer GitHub Actions trusted publishing/OIDC if configured; never request or paste account secrets into the chat. Do not publish without the user's explicit authorization.

**Out of scope:** writing an integration SaaS, OAuth, connector marketplace, framework rewrite, rate-limit service, or dashboard.

Return concise verification results, diff summary, blockers, and exact publish instructions. Keep the package small and honest.
