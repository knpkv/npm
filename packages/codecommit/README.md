# @knpkv/codecommit

CLI and TUI for AWS CodeCommit pull requests.

## Features

- Multi-account, multi-region PR dashboard (TUI and Web)
- **Local SQLite cache** — PRs are cached locally via libsql for instant search, offline access, and change notifications
- PR subscriptions with diff-based notifications (title changes, new comments, status updates)
- Health score ranking (staleness, review urgency)
- SSO login/logout management
- Full-text search across cached PRs
- Exact-revision PR workspace with changed-file navigation and native diff previews
- Prompt-only local Codex Relay passes for review, security, tests, and risk explanation
- Deterministic detached worktree checkout for the selected PR head

## Prerequisites

- AWS SSO configured (`~/.aws/config`)
- Git with the AWS CodeCommit credential helper configured for HTTPS checkout
- A locally authenticated `codex` executable for optional Relay actions
- On macOS or Linux, `/bin/sh`, `/bin/sleep`, and either `lockf` or `flock` for
  owner-death-safe repository/worktree locking. Checkout and Relay actions fail
  closed when neither locking command is installed; those actions are not
  currently supported on Windows.
- IAM permissions for CodeCommit (optionally granted per command):
  - `codecommit:ListRepositories`, `codecommit:ListPullRequests`, `codecommit:GetPullRequest`, `codecommit:GetRepository` — list/view and repository account identity
  - `codecommit:GetDifferences`, `codecommit:GetBlob` — exact-revision changed files and diff previews
  - `codecommit:GitPull` — detached worktree checkout and Relay review
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

Open a pull request to enter the exact-revision review workspace. The left pane
navigates changed files, the center renders immutable blob diffs, and the right
pane keeps local Relay actions separate from CodeCommit approval and
mergeability. After explicit preflight, Relay has the host produce a bounded
exact-commit patch with Git hooks disabled, then runs the local Codex CLI in
prompt-only mode. Prompt-only mode disables user and repository instructions,
host tools, and inherited shell variables, so repository-authored text cannot
read other files. Relay and worktree Git commands also clear inherited
repository-local `GIT_*` variables, so invocation from a Git hook cannot redirect
them into the caller's repository. Worktrees are detached at the displayed head under
`~/.codecommit/worktrees`, with private bare repository caches retained under
`~/.codecommit/repositories`. Both storage roots are enforced as user-only
directories (`0700`) before checkout. Cache and worktree coordinates include the
repository's AWS account ID, profile, region, and immutable head using
collision-resistant identity digests, and HTTPS Git
hosts are resolved for the region's AWS partition. Actions fail closed when the
repository account identity is unavailable. Both directories can grow over time.
Close the TUI, then remove a no-longer-needed repository's matching directories
from both roots; removing all of `~/.codecommit/worktrees` and
`~/.codecommit/repositories` clears every retained checkout and cache, which the
next checkout recreates. The comments tab shows only general comments without a
revision locator and threads attached to the displayed base/head pair.

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
