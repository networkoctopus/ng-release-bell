Fix duplicate projects after editing starred GitHub repositories

Editing an imported starred repository selected `github_manual` because the edit
provider list omitted `github`. The next starred sync imported a second project.
Preserve the original type in the editor and reject type conversion of imported
projects in the update API. Repeated automatic imports reuse an existing GitHub
subscription, including a manual subscription, without changing its ownership,
notification preferences, or release history. Unstarring still removes imported
subscriptions and leaves manual subscriptions alone.

Regression coverage exercises the actual Vue edit methods, API update, repeated
mocked starred sync, case-insensitive imports, preference/history preservation,
manual subscriptions, disabled imports, and unstarring. Existing duplicate data
is untouched; a read-only audit and remediation guidance are included.

A guarded latest-version migration corrects fresh initialization (the schema
already declares the column). No new schema migration or data cleanup is needed
for the duplicate fix itself.

Validation: all 30 tests pass on Node 26; the Vite production build passes.
The regression fails against the original editor (`github_manual` submitted).
Changed database/API/test/migration files pass ESLint. Full backend lint reports
two pre-existing errors: unused `DIGEST_TEMPLATE` and undefined `sendDigestEmail`.
Docker execution is unavailable locally.

Closes #6.
