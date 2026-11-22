# Publication checklist (owner must perform authenticated steps)

- [ ] Choose and verify npm name. Current `@your-npm-username/crashsafe-sync` is PLACEHOLDER, not a verified available package.
- [ ] Replace package name in package.json, README and example imports.
- [ ] Create real GitHub repository and set `package.json.repository` to its exact URL.
- [ ] Run `npm install` to generate `package-lock.json`; commit it; use `npm ci` in CI after that.
- [ ] Run the integration suite with an isolated Postgres database and `SYNC_TEST_DB_OK=yes`.
- [ ] Ensure CI passes on both supported Node versions.
- [ ] Verify `npm pack --dry-run` contains only intended dist and SQL files, not credentials or sample data.
- [ ] Validate the public exports by installing the generated npm tarball in a fresh example project.
- [ ] Check dependency and license terms. Keep any provider SDK optional.
- [ ] Verify package descriptions do not promise exactly-once external side effects.
- [ ] Configure npm 2FA and/or trusted publisher; do not paste tokens or passwords into AI chats.
- [ ] Prefer GitHub Actions OIDC trusted publishing for provenance, matching the exact repository/workflow.
- [ ] Perform `npm whoami`, `npm view <name>`, `npm publish --dry-run` on your own machine.
- [ ] Publish an initial beta after testing and checking the tarball, then verify the registry package and install command.

Docs: https://docs.npmjs.com/trusted-publishers/ and https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/
