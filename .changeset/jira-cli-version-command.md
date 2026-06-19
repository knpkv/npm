---
"@knpkv/jira-cli": minor
---

Add a `jira version` command for working with Jira project versions (releases),
backed by a new `VersionService`.

- `jira version list --project KEY` lists versions with Driver, Contributors and
  Approver fields resolved to display names. `--released`/`--unreleased` filter
  by state, `--custom-field "<name>"` (repeatable) includes per-ticket custom
  field values, and `--json` emits the raw objects.
- `jira version view <id>` shows a single version.
- `jira version set <id> --description <text>` edits the description.
- `jira version relatedwork list|add <id>` manages "Related work" links (the
  Confluence pages surfaced on a release report).

Mutations (`set`, `relatedwork add`) require the `manage:jira-project` OAuth
scope; the requested scopes now also include `read/write:project-version:jira`
for version entity properties. Re-run `jira auth login` to grant them.
