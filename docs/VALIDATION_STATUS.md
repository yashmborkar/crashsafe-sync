# Validation status — 2026-11-22

## What was run in this environment

- Node: v22.16.0, npm: 10.9.2
- TypeScript compiler: installed globally
- `tsc -p tsconfig.json`: PASSED
- `npm test`: PASSED (unit tests; no database)
- `npm run pack:check`: PASSED (package contents inspected)

## What has NOT been verified here

- `npm install` with registry dependencies: BLOCKED (outbound npm registry DNS unavailable)
- `npm run test:pg`: NOT RUN (no local PostgreSQL server and no `pg` install)
- Publication to npm: NOT ATTEMPTED (must be under the owner's authenticated account)
- Name availability: UNVERIFIED (placeholder scope in package.json)
- External maintainers' adoption feedback: NOT COLLECTED
- Process-kill tests against a real Postgres transaction: NOT RUN

**Important:** Writing a PostgreSQL integration test does not prove the library passes it. The next user/CI step is to run the integration suite and resolve any issues before publication.
