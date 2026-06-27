---
name: jira
description: Use the @knpkv/jira-cli command line tool to authenticate with Jira Cloud, fetch Jira issues, export issues to markdown, search by JQL or fixVersion, and inspect or update Jira project versions and related work links. Trigger when the user asks an agent to query Jira, collect tickets for release notes, write ticket markdown, inspect release metadata, or attach Confluence release-report links to a Jira version.
---

# Jira

Use the `jira` binary for Jira Cloud issue export and release-version workflows.

## Preconditions

- Authenticate first with `jira auth status`, `jira auth create`, `jira auth configure`, and `jira auth login`.
- Use `--json` on version commands when the agent needs structured data.
- Use numeric version ids for `jira version get`, `jira version update`, and `jira version related-work`.
- Confirm before remote write commands: `jira version update` and `jira version related-work add`.

## Authentication

```bash
jira auth status
jira auth create
jira auth configure --client-id <id> --client-secret <secret>
jira auth login
jira auth login --site https://example.atlassian.net
```

OAuth scopes used by release workflows include `read:jira-work`, `write:jira-work`, `manage:jira-project`, `read:jira-user`, `read:me`, and `offline_access`.

## Issue Export

Fetch one issue as markdown:

```bash
jira issue get PROJ-123 --output-dir ./jira-tickets
```

Search with JQL:

```bash
jira issue search 'project = PROJ AND status = Done' --output-dir ./jira-tickets
jira issue search 'fixVersion = "1.0.0"' --format single --max-results 200
```

Search by fix version:

```bash
jira issue search --by-version "1.0.0" --project PROJ
jira issue search --by-version "1.0.0" --project PROJ --format single
```

Output formats:

- `--format multi` writes one markdown file per issue.
- `--format single` writes `jira-export.md`.

## Version Workflows

List versions:

```bash
jira version list --project PROJ --json
jira version list --project PROJ --unreleased --max 10 --json
jira version list --project PROJ --custom-field "Security & Compliance Impact" --json
```

View a version:

```bash
jira version get 10042 --json
```

Update a version description:

```bash
jira version update 10042 --description "Q3 release"
```

Manage related work links:

```bash
jira version related-work list 10042 --json
jira version related-work add 10042 --title "Release notes" --url "https://example.atlassian.net/wiki/spaces/PROJ/pages/123" --category Communication
```

## Agent Workflow

1. Use read-only commands first to find issue keys, version ids, and current release metadata.
2. Prefer `--json` for release metadata and parse the resulting JSON instead of scraping tables.
3. Avoid printing tokens or OAuth secrets. Let interactive commands prompt for secrets when needed.
4. Confirm exact version id, title, URL, category, or description before mutating Jira.
