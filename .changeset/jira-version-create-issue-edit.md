---
"@knpkv/jira-cli": minor
"@knpkv/agent-skills": minor
---

Add `jira version create` and `jira issue edit`, closing the two gaps that forced release scaffolding out of the CLI.

`jira version create --project <KEY> --name <NAME>` opens a new unreleased version, optionally with `--description`, `--start-date` and `--release-date`. The project key is resolved to the numeric `projectId` the endpoint requires, and dates are validated as ISO 8601 locally so a bad one names its own flag instead of returning an unattributed 400.

`jira issue edit <KEY>` edits fix versions and labels. Both fields are sets, so the incremental flags — `--add-fix-version`, `--remove-fix-version`, `--add-label`, `--remove-label` — are the ones to reach for: they go through Jira's `update` verb, which applies server-side and cannot clobber a concurrent edit. The replacing forms (`--fix-version`, `--label`) are still available and say in their help that they drop anything not listed. Passing both forms for one field is refused up front, because Jira's own error for that case does not name the offending field.
