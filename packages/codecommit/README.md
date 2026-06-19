# @knpkv/codecommit

CLI and TUI for AWS CodeCommit pull requests.

## Features

- Multi-account, multi-region PR dashboard (TUI and Web)
- **Local SQLite cache** — PRs are cached locally via libsql for instant search, offline access, and change notifications
- PR subscriptions with diff-based notifications (title changes, new comments, status updates)
- Health score ranking (staleness, review urgency)
- SSO login/logout management
- Full-text search across cached PRs

## Prerequisites

- AWS SSO configured (`~/.aws/config`)
- IAM permissions for CodeCommit (optionally granted per command):
  - `codecommit:ListRepositories`, `codecommit:ListPullRequests`, `codecommit:GetPullRequest` — list/view
  - `codecommit:CreatePullRequest` — create
  - `codecommit:UpdatePullRequestTitle`, `codecommit:UpdatePullRequestDescription` — update
  - `codecommit:GetCommentsForPullRequest` — export
  - `codecommit:ListBranches` — branch listing

## Quick Start

```bash
pnpx @knpkv/codecommit
```

## Installation

```bash
pnpm add @knpkv/codecommit
```

## Usage

### TUI Mode (default)

```bash
codecommit
# or
codecommit tui
```

### Web Mode

```bash
codecommit web [--port 3000] [--hostname 127.0.0.1]
```

### Pull Request Commands

#### List PRs

```bash
codecommit pr list [options]
```

| Option      | Alias | Description                                    | Default     |
| ----------- | ----- | ---------------------------------------------- | ----------- |
| `--profile` | `-p`  | AWS profile (ignored with --filter)            | `default`   |
| `--region`  | `-r`  | AWS region (ignored with --filter)             | `us-east-1` |
| `--status`  | `-s`  | PR status, OPEN/CLOSED (ignored with --filter) | `OPEN`      |
| `--all`     | `-a`  | Show all PRs (ignored with --filter)           | `false`     |
| `--repo`    |       | Filter by repository                           | -           |
| `--author`  |       | Filter by author                               | -           |
| `--filter`  |       | Named preset, OPEN-only (see below)            | -           |
| `--json`    |       | Output as JSON                                 | `false`     |

```bash
codecommit pr list
codecommit pr list --status CLOSED
codecommit pr list --all
codecommit pr list --repo my-repo
codecommit pr list --author jane
codecommit pr list --json
```

#### Filter presets (`--filter`)

When `--filter` is set, the command fans out across **every enabled account**
in `~/.codecommit/config.json` (set up via `codecommit tui`) and returns the
merged list, sorted by last-modified-date. Presets operate on **OPEN PRs only**,
so `--profile`, `--region`, `--status`, and `--all` are all ignored when
`--filter` is set. Combine with `--json`, `--repo`, or `--author` for further
narrowing. If any account fails (e.g. an expired SSO session), a
`⚠ N account(s) failed` summary is printed to stderr and the PRs from the
accounts that succeeded are still returned.

| Preset            | Matches                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `mine`            | Open PRs you authored (matched against `getCallerIdentity` per profile)  |
| `needs-my-review` | Open PRs awaiting your approval (you're in an unsatisfied approval pool) |
| `stale`           | Open PRs with no activity for more than 7 days                           |
| `conflicting`     | Open PRs with merge conflicts                                            |

```bash
codecommit pr list --filter mine --json          # all my open PRs everywhere
codecommit pr list --filter needs-my-review      # what I need to review
codecommit pr list --filter stale --repo my-repo # stale PRs in one repo
codecommit pr list --filter conflicting --json
```

Output:

```
Found 3 open PR(s):

123  my-repo
    Add feature X
    feature/x -> main
    by alice  approved mergeable

124  my-repo
    Fix bug Y
    fix/y -> main
    by bob  conflicts
```

#### Create PR

```bash
codecommit pr create <repo> <title> -s <source-branch> [options]
```

| Option          | Alias | Description        | Default     |
| --------------- | ----- | ------------------ | ----------- |
| `--source`      | `-s`  | Source branch      | (required)  |
| `--destination` | `-d`  | Destination branch | `main`      |
| `--description` |       | PR description     | -           |
| `--profile`     | `-p`  | AWS profile        | `default`   |
| `--region`      | `-r`  | AWS region         | `us-east-1` |

```bash
codecommit pr create my-repo "Add feature X" -s feature/x -d main --description "Implements feature X"
```

#### Export PR Comments

Export PR comments as markdown with multi-level thread structure.

```bash
codecommit pr export <pr-id> <repo> [options]
```

| Option      | Alias | Description      | Default     |
| ----------- | ----- | ---------------- | ----------- |
| `--output`  | `-o`  | Output file path | stdout      |
| `--profile` | `-p`  | AWS profile      | `default`   |
| `--region`  | `-r`  | AWS region       | `us-east-1` |

```bash
codecommit pr export 123 my-repo
codecommit pr export 123 my-repo -o pr-comments.md
```

#### Update PR

```bash
codecommit pr update <pr-id> [options]
```

| Option          | Alias | Description        | Default     |
| --------------- | ----- | ------------------ | ----------- |
| `--title`       | `-t`  | New PR title       | -           |
| `--description` | `-d`  | New PR description | -           |
| `--profile`     | `-p`  | AWS profile        | `default`   |
| `--region`      | `-r`  | AWS region         | `us-east-1` |

```bash
codecommit pr update 123 -t "New title"
codecommit pr update 123 -d "Updated description"
codecommit pr update 123 -t "New title" -d "New description"
```

## AWS Configuration

Uses AWS SSO. Configure profiles in `~/.aws/config`:

```ini
[profile my-profile]
sso_session = my-sso
sso_account_id = 123456789012
sso_role_name = MyRole
region = us-east-1
```

Specify profile with `--profile` or `AWS_PROFILE` env var.

## License

MIT
