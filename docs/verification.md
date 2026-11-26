# Local verification

Verified on 2026-11-26 using a temporary Node.js 26.13.1 runtime and the existing
npm lockfile. No dependency versions or production data were changed.

| Branch | Result |
| --- | --- |
| `fix/starred-repository-duplicates` | 30 tests pass; production build passes; changed API/database/test/migration files pass ESLint |
| `feat/global-release-filtering` | 43 tests pass; production build passes; backend/tests and changed migrations pass ESLint |
| `test/combined-release-filtering` | 46 tests pass, including real HTTP fresh-install, old-SQLite-upgrade and restart tests; production build and backend/test/script/changed-migration lint pass |

The duplicate regression was also run against the original Vue editor. It fails
because the editor submits `github_manual` instead of `github`. The fixed editor
passes while preserving project ID, notification choices and release history
through repeated mocked starred synchronisation.

Feature coverage includes the unchanged include-all default, newly created and
starred subscriptions, global changes after import, explicit overrides in both
directions, legacy API edits, pending notification filtering, historical replay
suppression, prerelease promotion, metadata failure, stable detection behind a
newer prerelease with latest-version-only enabled, regex filters, instant/hourly/
daily/weekly scheduling, old and new JSON exports, duplicate import skipping,
disabled-project persistence, and all currently supported provider adapters.

All provider and SMTP transports in those regression tests are mocked. HTTP
restart tests use disposable databases, no provider credentials, no SMTP
configuration, and an existing project type without an external adapter. SQLite
migration tests preserve existing explicit preferences and exercise migration
reruns and reopening in a separate process.

Commands run on the combined branch:

```sh
npm ci --no-audit --no-fund
npm test
npm run build
npx --no-install eslint backend index.js scripts/test-container.cjs migrations/20260724180000-add-latest-version-only.js migrations/20261126190000-add-global-release-filtering.js
npx --no-install eslint --no-eslintrc --parser vue-eslint-parser --parser-options '{"ecmaVersion":2022,"sourceType":"module"}' frontend/App.vue
git diff --check
```

The repository has no npm lint script. Full lint of all historical migrations
still reports seven pre-existing errors (unused parameter / quote style);
those files are unchanged. On the independent duplicate branch, full backend
lint additionally reports the existing unused digest template and missing digest
sender. The feature branch restores that sender using the existing template and
retains scheduling intervals. `just` is unavailable locally; its build step was
run directly through npm.

Pending environment-dependent checks:

- Docker is not installed/available here. The new container smoke script and
  four-architecture build workflow are prepared but have not executed. Actual
  container fresh install, migration and restart results must be recorded after
  an approved local/CI run. The test script has passed syntax and lint checks.
- No Browser connection is available. The Vue file parses and builds, and its
  editor/preview logic is covered by tests; visual review and screenshots remain.
- No real GitHub account or production data was used for import tests. A test
  account can be used in the isolated Docker instance for a final provider check.
- No branch was pushed, workflow triggered, image published, release created,
  pull request submitted, or production deployment performed.

The test workflow passes actionlint 1.7.12 (shellcheck/pyflakes disabled), and
the test workflow and Compose YAML files parse successfully. Its action refs are
pinned to commits resolved from the official repositories. Both existing base
image manifests were checked: Linux amd64, arm64, ppc64le and s390x are present.
Upstream does not declare its own architecture matrix, and no readable public
upstream application image manifest was found at the checked registry names.
