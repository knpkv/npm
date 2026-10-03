# Issue Tracker

Where issues live for this repo, and how the engineering skills should read and write them.

## Tracker

**Local markdown.** Issues live as files in this repo under `.scratch/<feature>/`, one directory per
feature, with the spec or ticket set as Markdown files inside it.

There is no `gh issue` / `glab issue` workflow for this repo. Do not create GitHub Issues on
`knpkv/npm` for planning work; the GitHub remote is used for pull requests and releases only.

To publish an issue or spec: write the Markdown file under `.scratch/<feature>/`, and record its
triage label in the file's own metadata line rather than in a remote label system.

## PRs as a request surface

**Off.** Incoming pull requests are not part of the triage queue.

## Triage labels

The five canonical triage roles, each recorded as a `Label:` metadata line in the issue file:

- `needs-triage`
- `needs-info`
- `ready-for-agent`
- `ready-for-human`
- `wontfix`
