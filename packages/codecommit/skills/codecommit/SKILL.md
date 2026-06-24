---
name: codecommit
description: Use the @knpkv/codecommit CLI for AWS CodeCommit pull request workflows. Trigger when the user asks an agent to list, filter, create, export, update, review, or inspect CodeCommit pull requests; launch the CodeCommit TUI or web UI; or work with AWS SSO-backed CodeCommit repositories from the command line.
---

# CodeCommit

Use the `codecommit` binary to work with AWS CodeCommit pull requests from an agent session.

## Preconditions

- Require AWS SSO profiles in `~/.aws/config`.
- Prefer `codecommit pr list --json` for agent parsing.
- Pass `--profile` and `--region` when the target account is known.
- Use `codecommit tui` to configure multi-account settings before relying on `--filter` presets.
- Treat create and update commands as mutating operations; confirm the intended repository, branch, PR id, title, and description before running them.

## Common Tasks

List pull requests:

```bash
codecommit pr list --json
codecommit pr list --profile default --region us-east-1 --status OPEN --json
codecommit pr list --all --repo my-repo --json
```

Use cross-account presets after accounts are enabled in the TUI:

```bash
codecommit pr list --filter mine --json
codecommit pr list --filter needs-my-review --json
codecommit pr list --filter stale --repo my-repo --json
codecommit pr list --filter conflicting --json
```

Create a pull request:

```bash
codecommit pr create my-repo "Add feature X" --source feature/x --destination main --description "Implements feature X"
```

Export review comments as markdown:

```bash
codecommit pr export 123 my-repo --output pr-comments.md
```

Update pull request metadata:

```bash
codecommit pr update 123 --title "New title"
codecommit pr update 123 --description "Updated description"
```

Launch interfaces:

```bash
codecommit
codecommit tui
codecommit web --port 3000 --hostname 127.0.0.1
```

## Agent Workflow

1. Run read-only commands first (`pr list`, `pr export`) to establish the current state.
2. Keep stdout parseable by using `--json` where available.
3. If a command reports expired or failed AWS accounts, ask the user to refresh SSO with the relevant profile before retrying.
4. For mutating commands, echo the exact final command and run it only after the target is unambiguous.
