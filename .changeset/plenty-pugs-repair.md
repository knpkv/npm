---
"@knpkv/jira-cli": minor
---

Add `jira version related-work sync` — reconcile a version's related-work links
against the given set instead of blindly appending.

Repeated `related-work add` calls pile up duplicate "Release notes" links every
time a release is re-scaffolded. `sync` takes the desired set as repeatable
`--link title=url` flags and adds only what is missing, matching on URL (the
only stable identity a link has — Jira assigns the id and the title is
editable, so a link retitled by hand is still recognised). Scoped to one
`--category` so reconciling `Communication` cannot disturb `Testing` links.
`--prune` opts into removing extras, which is off by default because links
added by hand in the Jira UI are legitimate; it removes surplus copies of a
desired URL too, since an existing pile-up is the case it exists to clean up.
Repeated `--link` flags for one URL collapse to a single link.

The planning step is exposed as the pure `planRelatedWorkSync` and covered by
tests, including that a second run is a no-op.
