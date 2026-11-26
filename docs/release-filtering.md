# Release filtering preferences

Settings contains three global defaults:

- **Default release filtering:** stable releases only, or all releases including
  prereleases. Initially includes all releases, as before.
- **Exclude updated/overridden releases from notifications:** initially off.
- **Include latest version only:** initially off.

New starred imports and manual projects inherit all three defaults. Each project
can independently inherit or explicitly override each preference in Edit Project.
Inherited choices show the currently effective global value. For the two boolean
preferences, choose Inherit global setting, Yes, or No. Global changes immediately
affect inheriting projects' filtering, preview, and queued notifications. An
explicit override for one setting does not disable inheritance of the others.
Regex filters, enabled state, email frequency and digest scheduling remain separate.

## Existing installations

Upgrading preserves all existing stored choices. The previous boolean values do
not reveal whether they were deliberately configured. Existing projects therefore
retain explicit updated-release and latest-version values, even if they already
inherit the prerelease setting. Existing prerelease inheritance is preserved.

To adopt the defaults, change individual projects or check **Make all existing
projects inherit all three defaults when saving** in Settings. That explicit
action affects the current user's projects only, replacing all three overrides
with inheritance. Regex filters, release history and notification frequencies are
kept. Other users' settings and projects are unchanged.

## Notifications and release history

Changing preferences never resets historical notification flags. Suppressed
releases remain consumed, including pending releases excluded at dispatch.
Widening settings does not replay history.

Updated-release detection compares an existing tag's nonempty stored SHA with
its upstream SHA. A changed SHA now reaches the previously unreachable update
check. The existing release row and ID are retained, its SHA/metadata is refreshed,
and its `updated` marker allows both ingestion and dispatch to apply the current
exclusion preference. Repeated polls of the same SHA do not notify again.
Providers without comparable SHAs retain their existing detection limitations.

A prerelease promoted to stable is a release event, rather than an overridden
release; it can notify once even when updated releases are excluded. Notification
eligibility still applies the current prerelease preference, regex, latest-version
selection, enabled state and ten-day age cutoff. Known GitHub prereleases require
metadata refreshes; failed refreshes are retried rather than treated as stable.

Latest-version filtering chooses the highest eligible semantic version after
prerelease and regex filtering, so a newer prerelease does not suppress an older
stable release. Excluding an updated highest version does not fall back to notify
an older version when latest-only is enabled. The sync limit of 50 new or updated
versions per pass is retained.

Only providers already reporting prerelease metadata exclude prereleases.
Currently GitHub provides it; GitLab, Gitea, NPM, PyPI, Docker Hub, Quay, GHCR and
SourceForge retain their existing prerelease behaviour. Names alone do not
establish prerelease status.

## Persistence and compatibility

Export version 3 includes all global defaults and each project's raw boolean
values and independent inheritance flags. Import restores those defaults too,
affecting existing inheriting projects, and the UI refreshes the profile afterward.
Version 2 imports preserve prerelease inheritance while retaining explicit stored
updated-release/latest-version values. Version 1 and older exports retain explicit
values for all settings. Missing older booleans default to false; missing global
defaults leave the current user's corresponding default unchanged. Older API
clients sending a boolean without its inheritance flag create an explicit override
for that setting only.

The additive, idempotent migration adds `users.defaultExcludeUpdated`,
`users.defaultLatestVersionOnly`, `projects.inheritExcludeUpdated`,
`projects.inheritLatestVersionOnly` and `releases.updated`. All default to zero
for existing rows. It never rewrites existing preference or history rows. The
existing migration tracker is reused, without a destructive down migration.
Restore a pre-upgrade database backup and its matching image when rolling back;
older application versions cannot represent the new independent inheritance.
