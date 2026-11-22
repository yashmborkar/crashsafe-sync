# First stable publication

The package is `@yashborkar/crashsafe-sync` version `1.0.0`, with public access and the `latest` tag. Publication requires explicit owner authorization after the local checks and GitHub Actions CI succeed.

Run `npm ci`, `npm run typecheck`, `npm test`, `SYNC_TEST_DB_OK=yes DATABASE_URL=... npm run test:pg`, and `npm run pack:check` using a disposable PostgreSQL database. Review the package contents and confirm `npm whoami` identifies the owner.

For an initial manual release, run `SYNC_TEST_DB_OK=yes DATABASE_URL=... npm publish --access public --tag latest` from the verified commit using an authenticated npm session and complete npm's interactive authentication. Afterwards check `npm view @yashborkar/crashsafe-sync version dist-tags --json` and install the published package in a clean project.

npm's documented trusted publisher setup uses a package's settings. Its staged-publishing workflow can create a new package before it is installable, after which settings and trusted publishing can be configured. No staged or direct publish is authorized by this checklist. To use the GitHub workflow after configuring trust, select GitHub owner `yashmborkar`, repository `crashsafe-sync`, workflow `publish.yml`, and allow direct publishing. Newly created unvalidated trust configurations expire after two days. The manually dispatched workflow publishes the public package on `latest` and requests provenance.
