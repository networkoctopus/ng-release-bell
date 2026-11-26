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

Local Docker verification (Colima on Apple Silicon):

- Confirmed the `colima` context resolves to a local Unix socket. Every Docker
  operation was pinned to this context/socket; no remote production Docker host
  was contacted. Sandbox socket access required escalation and was granted.
- Docker client 29.10.1, engine 29.5.2 (Linux ARM64), Compose 5.8.0, Buildx 0.39.1,
  BuildKit 0.30.0, Colima 0.10.3; VM resources: four CPUs and 8 GiB memory.
- ARM64 Node execution, unchanged-Dockerfile application build, all 46 regression
  tests in a Linux ARM64 build-stage container, and runtime fresh-install,
  old-SQLite-upgrade, login/settings/history/session persistence and restart smoke
  tests all pass.
- AMD64 Node starts under Rosetta, but an arithmetic reproduction returned zero
  for `Math.floor(heap_size_limit * 0.25)` and npm failed constructing its cache.
  Switching to the existing QEMU handler produced the expected positive result.
  With QEMU, the unchanged Dockerfile builds for AMD64, all 46 Linux AMD64 tests
  pass, and both runtime fresh-install and SQLite-upgrade/restart smoke tests pass.
- The test Compose file passed config validation and startup/health/restart
  checks. A temporary copy used a unique container/volume name and network mode
  `none`. Verified a read-only root filesystem and nonroot UID 65532. All owned
  disposable test containers and volumes were removed afterward.
- Full tests also pass again on the Mac, and backend/test/script/changed-migration
  ESLint checks pass. No application code, dependencies or Dockerfile changes
  were needed.
- Local versioned runtime images are retained as
  `ng-release-bell:test-colima-9ac7f4f-arm64` and
  `ng-release-bell:test-colima-9ac7f4f-amd64`. They contain source commit `9ac7f4f`.
  Cached build-stage images have the same names with a `-checks` suffix.
- At the user's request, keep QEMU/binfmt enabled and Rosetta disabled in local
  Colima. Native ARM64 remains the normal fast development path; AMD64 uses
  emulation. The settings survived a full local Colima stop/start; Buildx then
  advertised `linux/amd64` and `linux/amd64/v2`. Both runtime images executed again
  afterward; AMD64 arithmetic and SQLite checks passed as nonroot UID 65532.
  CPU/memory settings remained four CPUs and 8 GiB. See the Apple Silicon section
  in `docs/docker-testing.md`.

Remaining checks:

- No Browser connection is available. The Vue file parses and builds, and its
  editor/preview logic is covered by tests; visual review and screenshots remain.
- No real GitHub account or production data was used for import tests. A test
  account can be used in the isolated Docker instance for a final provider check.
- The user has pushed the contribution branches. This verification did not
  trigger a workflow, push an image, create a release, submit a pull request,
  or deploy to production.

The test workflow passes actionlint 1.7.12 (shellcheck/pyflakes disabled), and
the test workflow and Compose YAML files parse successfully. Its action refs are
pinned to commits resolved from the official repositories. Both existing base
image manifests were checked: Linux amd64, arm64, ppc64le and s390x are present.
Upstream does not declare its own architecture matrix, and no readable public
upstream application image manifest was found at the checked registry names.

The local image builds and test containers had no SMTP credentials. Smoke and
regression containers ran with network access disabled; provider and email
regressions use mocks. Build-time package/base-image downloads used public
registries. Published multiarchitecture manifests and ppc64le/s390x execution
remain untested; local application execution was verified for ARM64 and AMD64.

Build-time npm audit output for the unchanged production dependency set reported
11 advisories (one moderate, eight high, two critical). Dependency upgrades were
not performed as part of this test run.
