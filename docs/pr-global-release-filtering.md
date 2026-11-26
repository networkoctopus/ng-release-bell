Add global release filtering with per-project inheritance

Automatically imported starred repositories and new manual projects now inherit a
user's default release filtering preference. Settings offers stable-only or all
releases; project editing offers inheritance or either explicit override and
shows the current inherited behaviour. Existing projects retain their explicit
stored preference. An unchecked, explicit Settings action makes existing projects
inherit when saving.

The existing `excludePrereleases` filtering is reused for ingestion, project
listing, preview, and queued notifications. Stable eligibility is determined
before latest-version selection. Previously tracked prereleases are refreshed so
promotion of the same tag to stable can notify once. Changing preferences never
resets historical notification flags. Regex filters, notification intervals, and
providers without prerelease detection retain their behaviour.

An idempotent migration adds `users.defaultExcludePrereleases` and
`projects.inheritReleaseFiltering`, both defaulting to zero for existing data.
The project creation path opts new projects into inheritance. Export version 2
includes the global preference and inheritance flag; version 1 imports remain
explicit and do not change the global default. Imports also preserve disabled
projects. Legacy API updates containing only `excludePrereleases` remain explicit.

Two existing defects surfaced during validation: the latest-version migration
unconditionally added a column already present in fresh schemas, and daily/weekly
notifications called an undefined digest sender. A column-existence guard and a
sender using the existing digest template allow fresh-install and scheduling
regression coverage. Scheduling intervals remain unchanged.

Validation: all 43 tests pass on Node 26; the Vite production build passes.
Backend, test, and changed-migration ESLint checks pass. Tests use temporary SQLite
databases and mocked provider/email transports; no real notifications are sent. UI screenshots could
not be captured because no Browser connection is available in this environment.

Closes #7.
