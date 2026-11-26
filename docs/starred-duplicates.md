# Starred repository duplicates

Editing an automatically imported GitHub repository previously changed its type
from `github` to `github_manual`. The next import created a new subscription.
The fix preserves the type, guards it in the update API, and makes automatic
imports reuse existing GitHub subscriptions (case-insensitively). Manual
subscriptions remain manual and survive unstarring. Automatically imported
subscriptions retain the existing removal-on-unstar behaviour.

No existing projects or release records are merged or deleted by this fix.
A manual subscription cannot reliably be distinguished from one converted by
the old editor. A project uniqueness migration would also fail on existing
installations containing duplicates, so none is introduced.

To audit a **backup copy** of the SQLite database, use this read-only query:

```sql
SELECT userId, lower(name) AS repository, count(*) AS subscriptions,
       group_concat(id) AS projectIds, group_concat(type) AS types
FROM projects
WHERE type IN ('github', 'github_manual')
GROUP BY userId, lower(name)
HAVING count(*) > 1;
```

Before remediation, stop the application and back up its entire persistent data
directory, including the database, any `-wal` / `-shm` files, and session secret.
Review each project's notification preferences and release history. Retaining a
manual project means it survives unstarring; retaining an imported project means
it follows stars. Deleting a project through the UI also deletes its releases.
Do not delete either copy merely because its settings look like defaults.
Merging history or choosing a survivor requires an explicit user decision and
should first be rehearsed against a copy of the backup.

The existing latest-version migration also needs a column-existence guard:
the fresh schema already declares that column. This prerequisite changes no
stored preferences and makes fresh initialization and migration reruns safe.
