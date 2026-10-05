---
"@knpkv/atlassian-common": minor
"@knpkv/jira-cli": minor
"@knpkv/confluence-to-markdown": minor
---

One error report for every Atlassian CLI (`jira`, `confluence`, `atlassian`), from the new `@knpkv/atlassian-common/cli` subpath (`handleCliError`, `withCliErrorHandling`, `Verbose`, `commandArgs`, `verboseRequested`).

- A failed command prints the error's message; a defect prints `Error: <message>`. The full cause, with stack traces, prints only with the new global `--verbose` flag or `DEBUG=1`.
- jira: stderr no longer prints the pretty-printed cause and stack trace by default.
- atlassian: tagged errors print their message instead of `String(error)`, and defects are reported too.
- Help and usage errors that the CLI already rendered are not printed a second time. Exit codes are unchanged.
