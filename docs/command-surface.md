# Command Surface Design

This document records the target command shape for the `@knpkv` CLI packages. It is the implementation source of truth until the Documentation Site is available.

## Goals

- Preserve existing Product Binaries: `jira`, `confluence`, `codecommit`, and `jcf`.
- Prefer Resource Commands for domain objects.
- Use Sync Workflow Commands for local workspace reconciliation.
- Keep product-specific nouns where they make the CLI clearer.
- Teach only Canonical Commands in docs, help text, and agent skills.
- Allow breaking changes when a canonical shape is clearer than the legacy command.
- Remove legacy commands completely rather than keeping compatibility aliases.

## Shared Conventions

- `auth` is the authentication namespace.
- `config` is the local tool configuration namespace.
- `skills install` installs bundled agent skills.
- `--json` follows the JSON Output Contract: stdout contains exactly one JSON value, while progress, warnings, and human hints go to stderr.
- `--dry-run` is available only when the command can accurately preview its changes.
- Read-Only Commands do not require confirmation.
- Remote Write Commands remain scriptable when Explicit Intent is provided.
- Agent skills must ask for confirmation before running Remote Write Commands.
- Command Reference pages classify each command as read-only, local write, or remote write.
- Legacy command spellings are not exposed as hidden aliases.
- CLI help descriptions include the mutability class when practical: read-only, local write, or remote write.

## Canonical Commands

### Jira

```bash
jira issue get PROJ-123 --output-dir ./jira-tickets
jira issue search 'project = PROJ' --output-dir ./jira-tickets
jira issue search --by-version "1.0.0" --project PROJ

jira auth status
jira auth profiles
jira auth use <profile>
jira auth remove <profile>

jira version list --project PROJ --json
jira version get 10042 --json
jira version update 10042 --description "Q3 release"
jira version related-work list 10042 --json
jira version related-work add 10042 --title "Release notes" --url "https://example.atlassian.net/wiki/spaces/PROJ/pages/123"
```

Key changes:

- `jira get` becomes `jira issue get`.
- `jira search` becomes `jira issue search`.
- `jira version view` becomes `jira version get`.
- `jira version set` becomes `jira version update`.
- `jira version relatedwork` becomes `jira version related-work`.

### Confluence

```bash
confluence workspace clone --root-page-id <page-id> --base-url https://example.atlassian.net

confluence auth status
confluence auth profiles
confluence auth use <profile>
confluence auth remove <profile>

confluence sync status
confluence sync diff
confluence sync pull
confluence sync push
confluence sync push --dry-run
confluence sync commit --message "Update release notes"
confluence sync log

confluence page get --page-id <page-id> --base-url https://example.atlassian.net
confluence page get --url https://example.atlassian.net/wiki/pages/<page-id>
confluence page new
confluence page delete
```

Key changes:

- `confluence clone` becomes `confluence workspace clone`.
- `confluence status`, `diff`, `pull`, `push`, `commit`, and `log` move under `confluence sync`.
- `confluence new` becomes `confluence page new`.
- `confluence delete` becomes `confluence page delete`.
- `confluence fetch` becomes `confluence page get` when used as a one-off page read.

### CodeCommit

```bash
codecommit pr list --json
codecommit pr create my-repo "Add feature X" --source feature/x --destination main --description "Implements feature X"
codecommit pr export 123 my-repo --output pr-comments.md
codecommit pr update 123 --title "New title"

codecommit tui
codecommit web --port 3000 --hostname 127.0.0.1
```

Key decisions:

- Keep `pr` as the canonical pull-request resource namespace.
- Preserve `tui` and `web` as interface launch commands.

### Jira Clockify

```bash
jcf timer start PROJ-123
jcf timer stop
jcf timer discard
jcf timer status
jcf timer log PROJ-123 --time 1h
jcf timer edit

jcf issue list --json
jcf sync reconcile

jcf auth status
jcf config show
```

Key changes:

- Timer operations move under `jcf timer`.
- `jcf list` becomes `jcf issue list`.
- `jcf reconcile` becomes `jcf sync reconcile`.

## Documentation Site

The Documentation Site will live in `packages/docs`, use Astro Starlight, and remain private. It starts as CLI-first:

- Guide
- Conventions
- Jira
- Confluence
- CodeCommit
- Jira Clockify
- Agent Skills
- Migration
- Lightweight package pages

Product Guides are handwritten. Command Reference pages should be generated or snapshotted from the CLI help after the command names stabilize.

## Implementation Order

1. Write this command convention spec and migration map.
2. Refactor CLI command trees to canonical names.
3. Add or normalize `--json`, stdout/stderr behavior, and truthful `--dry-run`.
4. Update agent skills to canonical commands and mutability guidance.
5. Add `packages/docs` with Astro Starlight and initial content.
6. Add generated or snapshotted Command Reference pages.

## Agent Skills

- Product packages should continue to ship their relevant bundled skills.
- Skill content should have one source of truth to prevent product-local copies from drifting.
- `packages/agent-skills/skills/*` is the preferred authoring source.
- Product-local `skills/` directories should be generated or copied from that source, not edited independently.

## Tests

- Add targeted command-tree tests for each Product Binary.
- Assert Canonical Commands exist.
- Assert removed legacy commands do not exist.
- Prefer targeted help assertions over broad golden snapshots.
- Add JSON Output Contract tests for commands documented for agent parsing.
- Add a skill sync check that fails when product-local bundled skills drift from the single authoring source.
