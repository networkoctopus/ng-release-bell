# Testing the combined changes with Docker

These files are kept on `test/combined-release-filtering`, separate from the two
upstream contribution branches. No images or pull requests have been published.
The existing Dockerfile and production Compose file are unchanged.

## Build and publish after review

The manually dispatched **Build fork test image** workflow in
`.github/workflows/test-image.yml` is restricted to `networkoctopus/ng-release-bell`.
It tests the application, builds the existing Dockerfile, and runs disposable
fresh-install, old-SQLite-upgrade, and container-restart smoke tests with network
access disabled. It then builds Linux amd64, arm64, ppc64le, and s390x images.

Upstream has no declared architecture build matrix or readable public image
manifest at the namespaces checked. Both existing Docker base image manifests
advertise these four architectures; this is the prepared build target set, not a
claim that four-architecture container builds have already passed.

The workflow defaults to **publish=false**. Publishing requires deliberately
selecting **publish=true**. It authenticates to GHCR using the workflow token with
`packages: write`, following [GitHub's publishing documentation](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images).
The image name comes from the fork repository. The repository restriction
prevents publishing under the upstream maintainer's namespace. No release or
`latest` tag is created. Official action versions are pinned to commit SHAs.

The resulting tag has this form:

```
ghcr.io/networkoctopus/ng-release-bell:test-release-filtering-v1-<12-character-commit>
```

After approval, push the combined branch and workflow. GitHub requires a
`workflow_dispatch` workflow to be present on the default branch before it can
be dispatched normally. Add this fork-only workflow to the fork's default branch
if necessary, then select the combined branch for the run. Review package
visibility/access in GHCR before pulling from your server. Record the published
image digest and prefer `image@sha256:...` for repeatable testing.

If Actions cannot be used yet, build locally without publishing:

```sh
git switch test/combined-release-filtering
docker build -t ng-release-bell:test-release-filtering-v1 .
node scripts/test-container.cjs ng-release-bell:test-release-filtering-v1
```

The smoke script removes only its own UUID-named containers and test volumes.
A workflow run with publication disabled builds the multiarchitecture image for
validation but does not make an image available to pull.

## Isolated test instance

Use the standalone test Compose file, not an overlay on production:

```sh
export NG_RELEASE_BELL_TEST_IMAGE='ghcr.io/networkoctopus/ng-release-bell:test-release-filtering-v1-<actual-commit>'
export TEST_ADMIN_PASSWORD='choose-a-separate-test-password'
docker compose -p ng-release-bell-test -f docker-compose.test.yml config
docker compose -p ng-release-bell-test -f docker-compose.test.yml pull
docker compose -p ng-release-bell-test -f docker-compose.test.yml up -d --no-build
docker compose -p ng-release-bell-test -f docker-compose.test.yml restart
docker compose -p ng-release-bell-test -f docker-compose.test.yml logs
```

Open http://localhost:3112 on the Docker host (or use an SSH tunnel). The file uses
`ng-release-bell-test-data` and a separate container name. SMTP variables and
environment provider tokens are explicitly empty, even if the local `.env`
contains production credentials. Add a test GitHub token through the UI only
when exercising real read-only starred import; use a test account. Do not use
production mail settings. Token values stored in a copied database remain active
unless removed; see below.

To stop the test instance while retaining its data:

```sh
docker compose -p ng-release-bell-test -f docker-compose.test.yml down
```

Do not use `just docker-clean` or `just clean` for a deployment you want to keep:
the existing recipes run `docker compose down -v` and remove volumes.

For a later approved production image substitution, replace `build: .` with:

```yaml
services:
  ng-release-bell:
    image: ghcr.io/networkoctopus/ng-release-bell:test-release-filtering-v1-<actual-commit>
```

Keep all existing ports, environment values, volume paths, user and security
settings. That snippet shows only the changed service property; it is not a
complete Compose deployment file. Use `up -d --no-build` after review and backup.

## Backup before testing an existing installation

Do not point a test container at the live production volume. Any production
stop or configuration change requires the owner's approval first.

Record the exact currently running image ID/digest, Compose configuration, and
actual volume or bind-mount source. A JSON export is useful for preferences, but
is not a full backup: it omits release history, notification flags and secrets.

For a named volume, the following is a template to run only after approving the
brief production stop. Fill in the actual volume name and container name first:

```sh
PRODUCTION_VOLUME='actual-existing-volume-name'
ORIGINAL_IMAGE=$(docker inspect --format '{{.Image}}' ng-release-bell)
BACKUP_DIR="$PWD/ng-release-bell-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$BACKUP_DIR"
printf '%s\n' "$ORIGINAL_IMAGE" > "$BACKUP_DIR/original-image.txt"
docker compose stop ng-release-bell
docker run --rm --network none --user 0 \
  --mount "type=volume,src=$PRODUCTION_VOLUME,dst=/source,readonly" \
  --mount "type=bind,src=$BACKUP_DIR,dst=/backup" \
  --entrypoint /nodejs/bin/node "$ORIGINAL_IMAGE" \
  -e "require('node:fs').cpSync('/source','/backup/data',{recursive:true,force:false,errorOnExist:true})"
docker image save -o "$BACKUP_DIR/original-image.tar" "$ORIGINAL_IMAGE"
docker compose start ng-release-bell
```

Check that backup files are readable before changing the deployed image. Copy
Compose/environment files into secure backup storage as well. Keep this backup
outside the repository and protect it: it contains tokens, password hashes and
the session secret. For a bind mount, copy the entire mounted directory while
the service is stopped. Never copy only the `.db` file from a running service:
SQLite WAL can contain committed changes not yet checkpointed into that file.

Restore the entire backed-up data directory into a **new test volume**, including
any `.db-wal`, `.db-shm`, and `session.secret` files. Maintain ownership 65532:65532
for the nonroot image. Run SQLite `PRAGMA integrity_check` against the restored
copy and confirm it returns `ok` before using it. Before starting the copy,
clear `githubToken` / `quayToken` and disable `githubAutoImport` in the copied
`users` table; add separate test credentials later. Never run these SQL changes
against the production database. SMTP stays disabled in the test Compose file.

## Rollback

Keep the original production volume untouched while testing its copy. Stopping
the test instance leaves production as it was.

If an approved production upgrade later needs rollback, stop the upgraded
container. Load the saved original image if needed, restore the **pre-upgrade**
backup into a new volume, set that volume as the original Compose data source,
and select the saved original image ID/digest. Verify restored file ownership,
SQLite integrity, settings and release counts before starting. Retain the failed
upgrade volume for investigation. Do not run an older image against the upgraded
database or delete migration records to simulate rollback. Restore database and
session secret together; sessions created after the backup may require login.

## Apple Silicon with local Colima

Use an explicit local context so these commands never select a remote Docker
host from the surrounding environment:

```sh
docker context inspect colima
docker --context colima version
docker --context colima compose version
docker --context colima buildx version
docker --context colima buildx build --builder colima --platform linux/arm64 --load -t ng-release-bell:test-local-arm64 .
DOCKER_CONTEXT=colima DOCKER_HOST="unix://$HOME/.colima/default/docker.sock" node scripts/test-container.cjs ng-release-bell:test-local-arm64
```

The checked endpoint must be a local Unix socket. On this Mac, Node 26 AMD64
containers started under Rosetta but produced an incorrect floating-point result,
causing npm's PackumentCache construction to fail. QEMU AMD64 emulation corrected
the result and allowed the unchanged Dockerfile to build. Keep native ARM64 for
normal development; QEMU is slower but provides a working AMD64 test path here.

The retained local Colima configuration uses `rosetta: false` and `binfmt: true`.
Those correspond to `colima start --vz-rosetta=false --binfmt` after stopping the
local VM. Stop/restart only after checking for other local workloads. This is a
local machine configuration, not an application requirement or a production
Dockerfile change.
