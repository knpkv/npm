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

| Option      | Alias | Description             | Default     |
| ----------- | ----- | ----------------------- | ----------- |
| `--profile` | `-p`  | AWS profile             | `default`   |
| `--region`  | `-r`  | AWS region              | `us-east-1` |
| `--status`  | `-s`  | PR status (OPEN/CLOSED) | `OPEN`      |
| `--all`     | `-a`  | Show all PRs            | `false`     |
| `--repo`    |       | Filter by repository    | -           |
| `--author`  |       | Filter by author        | -           |
| `--json`    |       | Output as JSON          | `false`     |

```bash
codecommit pr list
codecommit pr list --status CLOSED
codecommit pr list --all
codecommit pr list --repo my-repo
codecommit pr list --author jane
codecommit pr list --json
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
