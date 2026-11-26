# Release filtering preferences

Settings → Default release filtering selects either stable releases only or all
releases, including prereleases. The initial default includes all releases, as
before. New starred imports and manual projects inherit this setting.

Edit Project → Release filtering selects inheritance or an explicit stable/all
override. Inherited projects display their current effective choice. Global
changes apply to inheriting projects immediately, including project-list display
and queued notifications. Regex filters, re-release preferences and email
frequencies remain separate.

Existing installations retain every stored project preference on upgrade. The
old boolean contains no evidence of whether the user deliberately chose it, so
the migration marks existing projects explicit. To opt in, change individual
projects or check **Make all existing projects inherit when saving** in Settings.
That action affects all of the current user's projects and leaves other users,
regex filters, enabled state, release history and email frequencies alone.

Changing preferences does not replay release history. Already suppressed releases
stay suppressed. Pending releases excluded at dispatch are consumed, rather than
queued for a later replay. A newly observed promotion from prerelease to stable
is a release event and can notify once, subject to current filters, enabled state,
latest-version selection, and the existing ten-day age cutoff. Refreshing known
GitHub prereleases adds metadata requests during synchronization. Metadata errors
are retried rather than interpreted as a stable promotion.

Only providers that already report prerelease metadata filter prereleases.
Currently GitHub provides that metadata; GitLab, Gitea, NPM, PyPI, Docker Hub,
Quay, GHCR and SourceForge retain their existing behaviour. Tag names alone do
not establish prerelease status. The existing 50-new-versions-per-sync limit is
unchanged.

Export version 2 includes `settings.defaultExcludePrereleases` and each project's
`inheritReleaseFiltering` plus its stored boolean. Importing this format restores
the global preference as well, affecting existing inheriting projects. The UI
refreshes the profile after import. Version 1 and older exports without these
fields retain explicit project values, default missing booleans to include all,
and leave the global setting alone. Older application versions cannot represent
inheritance; use a pre-upgrade backup when rolling back instead of importing a
version 2 export into an older application.

The migration adds two integer columns and never rewrites existing preference or
release records. It can be rerun safely and uses the existing `_migrations`
tracking mechanism. It does not provide a destructive down migration.
