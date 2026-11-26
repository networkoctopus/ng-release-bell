Add global release filtering with independent project overrides

New starred imports and manual projects inherit three per-user defaults:
prerelease filtering, updated/overridden-release exclusion, and latest-version-only
filtering. Each project can independently inherit or override each preference;
the editor shows the current inherited choice. Existing stored preferences remain
explicit on upgrade. An unchecked Settings action lets the user make all current
projects inherit all three defaults when saving.

A shared preference mapping resolves the existing boolean filtering mechanisms
for ingestion, listing, preview and queued notifications. Stable eligibility is
applied before highest-semver selection. Changing defaults does not reset old
notification flags. Existing regex, enabled state and notification intervals stay
independent. Known prereleases are refreshed to detect stable promotion once.

The previous updated-release check was unreachable because known versions were
removed before SHA comparison. Changed SHAs are now processed in place, preserving
release IDs and preventing repeat notifications for the same SHA. A persisted
`updated` marker lets queued notifications respect preference changes too. Stable
promotion remains distinct from an overridden release, including a changed SHA.

Additive guarded migrations retain existing booleans and prerelease inheritance.
New project creation opts into each default independently. Version 3 exports retain
all defaults/flags, while version 1/2 imports preserve their explicit preferences.
Legacy boolean-only API updates remain explicit overrides for that setting.

Earlier validation also fixed two prerequisites: a latest-version migration that
re-added an existing fresh-schema column, and daily/weekly notifications calling
an undefined digest sender. The guard and existing digest template preserve
scheduling intervals.

Regression coverage includes inheritance and overrides in both directions,
changing settings after import, same-tag SHA updates, stable promotion, queued
filtering without historical replay, regex/latest-version interaction, old schema
upgrades and process/container restarts, import/export and supported providers.
Tests use disposable data and mocked provider/email transports. See
`docs/verification.md` for current results. Visual review/screenshots remain pending
because this environment has no Browser connection.

Closes #7.
