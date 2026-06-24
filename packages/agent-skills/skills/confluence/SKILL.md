---
name: confluence
description: Use the @knpkv/confluence-to-markdown CLI to clone, sync, edit, commit, diff, and push Confluence Cloud pages as local GitHub Flavored Markdown. Trigger when the user asks an agent to manage Confluence documentation, inspect local Confluence sync status, create or delete pages, pull remote updates, or publish markdown changes back to Confluence.
---

# Confluence

Use the `confluence` binary to manage a local markdown mirror of Confluence Cloud pages.

## Preconditions

- Run commands from the workspace that contains, or should contain, the `.confluence/` sync directory.
- Authenticate before clone or sync with `confluence auth create`, `confluence auth configure`, and `confluence auth login`.
- Use OAuth for normal operation. API-token env vars may be available as `CONFLUENCE_API_KEY` and `CONFLUENCE_EMAIL`.
- Confirm before running `confluence push`, because it writes to Confluence.
- Confirm before running `confluence delete`, because it removes a local page that will be deleted remotely on the next push.

## Setup

```bash
confluence auth status
confluence auth create
confluence auth configure --client-id <id> --client-secret <secret>
confluence auth login
confluence auth login --site https://example.atlassian.net
```

Clone a page tree:

```bash
confluence clone --root-page-id <page-id> --base-url https://example.atlassian.net
```

`clone` initializes `.confluence/`, creates local git history, and creates the `origin/confluence` tracking branch.

## Sync Workflow

Inspect before changing anything:

```bash
confluence status
confluence diff
confluence log --oneline
```

Pull remote changes:

```bash
confluence pull
confluence pull --force
confluence pull --replay-history
```

Commit local markdown edits:

```bash
confluence diff
confluence commit --message "Update release notes"
```

Preview and publish:

```bash
confluence push --dry-run
confluence push
```

## Page Operations

Create a page interactively:

```bash
confluence new
```

Delete a page locally, then commit and push the deletion:

```bash
confluence delete
confluence commit --message "Delete obsolete page"
confluence push
```

## Agent Workflow

1. Start with `confluence status` and `confluence diff`.
2. Read and edit markdown files under the configured docs path, usually `.confluence/docs`.
3. Use `confluence commit` instead of raw git for normal sync commits so external docs paths are copied into `.confluence/`.
4. Use `confluence push --dry-run` before `confluence push`.
5. Mention fidelity limits when editing complex Confluence content: media, panels, task lists, expand sections, dates, emojis, inline cards, and some marks may not round-trip exactly.
