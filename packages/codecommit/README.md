# @knpkv/codecommit

CLI and TUI for AWS CodeCommit pull requests.

## Features

- Multi-account, multi-region PR dashboard (TUI and Web)
- **Local SQLite cache** — PRs are cached locally via libsql for instant search, offline access, and change notifications
- PR subscriptions with diff-based notifications (title changes, new comments, status updates)
- Health score ranking (staleness, review urgency)
- SSO login/logout management
- Full-text search across cached PRs
- Exact-revision PR workspace with hierarchical navigation, API-first diff previews, and optional local worktrees
- Prompt-only local Codex Relay passes with description suggestions, file-anchored PR comments, or exact line comments that a human can discuss, publish, acknowledge, or reject
- Explicit deterministic detached checkout of the selected PR head with provider-drift detection
- Exact-head pull-request merge with explicit strategy selection and confirmation

## Prerequisites

- AWS SSO configured (`~/.aws/config`)
- Git and the AWS CLI. Exact-head checkout configures the AWS CodeCommit HTTPS
  credential helper per command for the selected profile; no global Git helper
  setup is required.
- [Granted](https://granted.dev) with the `assume` executable configured for
  opening a selected pull request in the matching AWS account console
- A locally authenticated `codex` executable for optional Relay actions
- Docker for optional web-mode review sandboxes. Sandbox IDE ports are
  loopback-only and require the per-sandbox password shown by the web UI.
- `nvim` for the same-terminal Neovim shortcut and/or the VS Code `code` CLI
  for the external editor shortcut
- On macOS or Linux, `/bin/sh`, `/bin/cat`, and either `lockf` or `flock` for
  owner-death-safe repository/worktree locking. Checkout and Relay actions fail
  closed when neither locking command is installed; those actions are not
  currently supported on Windows.
- IAM permissions for CodeCommit (optionally granted per command):
  - `codecommit:ListRepositories`, `codecommit:ListPullRequests`, `codecommit:GetPullRequest`, `codecommit:GetRepository` — list/view and repository account identity
  - `codecommit:GetDifferences` — exact-revision changed files
  - `codecommit:GetBlob` — default API diff previews and mandatory exact-line publication validation
  - `codecommit:GitPull` — explicit exact-head local diffs, detached worktrees, and Relay review
  - `codecommit:CreatePullRequest` — create
  - `codecommit:UpdatePullRequestTitle`, `codecommit:UpdatePullRequestDescription` — update
  - `codecommit:GetCommentsForPullRequest` — export and idempotent review-comment reconciliation
  - `codecommit:PostCommentForPullRequest` — explicitly post a reviewed Relay finding
  - `codecommit:GetMergeConflicts` — advisory mergeability status for the exact pull-request revision
  - `codecommit:MergePullRequestByFastForward`, `codecommit:MergePullRequestBySquash`, `codecommit:MergePullRequestByThreeWay` — explicitly confirmed TUI merge using the selected native strategy
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

Open a pull request to enter the exact-revision review workspace. Opening is
API-first: the TUI reads the advertised base/head and changed-file metadata,
then renders selected files with bounded CodeCommit `GetBlob` reads without
running Git or downloading source. The left pane navigates changed files as a
shared-directory tree, the center renders a two-sided provider diff, and the
right pane keeps local Relay actions separate from CodeCommit approval and
mergeability. Press `w`, then confirm, to create or reuse the deterministic
detached worktree and switch subsequent previews to immutable local Git blobs.
While a local worktree is active, the TUI checks provider revision metadata
every 30 seconds. A changed base or head immediately returns the preview to API
mode, labels the retained checkout as outdated, and offers `w` to update it.

Press uppercase `M` in the Changes tab to choose **squash**, **fast-forward**,
or **three-way**, then review the displayed base, head, and destination ref.
Press `Enter` to send the merge. This path stays API-first and never creates a
worktree: immediately before writing, it re-reads the pull request and verifies
the exact repository, revision, base, head, and destination reference. The AWS
request pins `sourceCommitId` to the displayed head, so CodeCommit rejects a
source branch that moves after preflight. CodeCommit exposes no destination
compare-and-set for this operation: if the destination advances after preflight,
the provider may use that newer destination, including for a three-way merge.
The submitted action also captures the resolved STS caller account and
repository-owner account from the selected PR. Immediately before the merge
write, `GetCallerIdentity`, `GetRepository`, authorization, and the merge share
one credential snapshot; either mismatch makes zero merge calls and forces a
refresh.
Once submitted, the TUI waits for the
CodeCommit receipt because cancelling a non-idempotent merge request could hide
a merge that already completed. Approval-rule failures, stale revisions,
closed pull requests, and merge conflicts return to the action card without
replaying the write. A successful merge records a notification, refreshes the
pull-request list, and returns to it.

After explicit action confirmation, Relay has the host produce a bounded
exact-commit patch with Git hooks disabled, then runs the local Codex CLI in
prompt-only mode. Prompt-only mode disables user and repository instructions,
host tools, and inherited shell variables, so repository-authored text cannot
read other files. Relay and worktree Git commands also clear inherited
repository-local `GIT_*` variables, suppress configured Git hooks, close stdin,
and disable terminal credential prompts. Worktree population also ignores
global and system Git configuration and attributes, preventing repository
`.gitattributes` from selecting host-configured smudge or process filters; Git
credential configuration remains available only to the separate clone/fetch
transport steps. Missing immutable commits are fetched through the pull
request's advertised source and destination branch refs, then verified by exact
commit ID before checkout; raw commit IDs are never used as fetch refspecs.
Invocation from a Git hook therefore cannot redirect commands
into the caller's repository, and authentication failures return to the TUI
instead of waiting on an invisible prompt. After a successful explicit
checkout, selected previews load on demand from that exact local checkout.
Provider and local previews remain keyed in memory by exact base, head, path,
and blob pair, and switching sources clears the in-memory preview cache first.
Worktrees are detached at the displayed head under
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
next checkout recreates. The comments tab shows every posted thread, placing
threads for the displayed base/head pair first and retaining comments from older
revisions. Each thread group starts with an explicit `GENERAL`, `FILE`, or
`LINE N` coordinate so its relationship to the pull request or changed file is
visible before the comment body. File and line threads also state whether their
coordinate belongs to the current revision, an older head, or an unspecified
revision.

In the Changes tab, `n` opens the selected exact-head file in Neovim using the
same terminal. The TUI suspends while Neovim owns the terminal and restores the
same PR workspace when Neovim exits. `v` opens the file in an existing VS Code
window through `code --goto`. When a selected Relay finding supplies a line
anchor for that file on the after/head side, both shortcuts open at that line.
Before/base-side anchors open a surviving head file without applying the base
line number. Deleted files cannot be opened from the exact-head checkout unless
a separate verified base artifact is explicitly materialized.
Editor targets are
canonicalized and must remain regular files inside the verified detached
worktree; deleted files and paths or symlinks that escape it are rejected. Text
changes render side by side by default, with the base revision on the left and
head revision on the right. Both panes keep aligned line numbers and synchronized
scrolling.

Relay returns decoded findings anchored to the whole PR, a changed file, or an
exact before/after line and proposes one publication target: the PR description,
a PR comment (including file-anchored findings), or an exact line comment. Press `g` before starting a review to choose one or
both trusted, prompt-only review playbooks: **PR Review** for broad defect
coverage and **PR Diff Review** for high-confidence, evidence-led diff review.
The selection is snapshotted when the action starts. Findings use the same
P1–P4 issue contract as those playbooks and separate Summary, Details,
Recommendation, Verification, publication target, and Location in both the TUI
and posted comment. `[`/`]` wraps through the finding deck, `u` jumps to the
next undecided finding, and selecting a finding selects its file in the diff.
Press `m` to change among the targets supported by its evidence anchor. Press
`d` to continue a finding-specific conversation with the read-only local agent.
Every follow-up receives the full current review and can revise, add, merge, or
withdraw other findings; the TUI reports the reconciliation and reopens affected
local decisions. A changed finding that was already published is marked stale
instead of pretending the provider copy changed.

When the PR author pushes a fix, press `V` on the finding to verify it. Relay
refreshes CodeCommit's latest revision, prepares a clean exact-head checkout,
and re-runs the relevant review reasoning against the complete new patch. The
receipt distinguishes **resolved**, **still open**, **superseded**, and
**inconclusive**, states whether the head changed, and reconciles the whole
finding deck because one fix can change other review decisions. Verification is
read-only and never publishes or updates the PR. Lowercase `v` continues to open
the selected file in VS Code.

The human must explicitly choose `p` to publish one finding to CodeCommit, `a`
to acknowledge it locally, or `x` to reject it locally. CodeCommit does not offer
a conditional description update, so description suggestions fail closed and
must be copied manually; this prevents overwriting concurrent author edits.
File-scoped findings publish as PR comments with their file anchor in the body,
while exact changed-side line findings use provider line coordinates. Comment targets use a hexadecimal
SHA-256 digest as their deterministic idempotency token. The canonical identity
is the UTF-8 JSON serialization of this versioned array, preserving this exact
order:

```json
[
  "relay-finding-v2",
  "111122223333",
  "eu-west-1",
  "npm-control-center-review",
  "35",
  "revision-id",
  "<40-hex-base-commit>",
  "<40-hex-head-commit>",
  "P1",
  "Finding title",
  "Finding summary",
  "Finding evidence and impact",
  "Recommended remediation",
  "Verification procedure",
  "line-comment",
  ["line", "src/example.ts", 42, "after"]
]
```

The array elements are, after the version: resolved CodeCommit repository account ID, AWS region, repository
name, pull request ID, revision ID, destination commit, source commit, finding
priority, title, summary, details, recommendation, verification, publication
target, and location. Session-local finding IDs are excluded because the same
provider-visible finding may be renumbered by a later review. JSON escaping makes embedded NULs and field
boundaries unambiguous. The location is `["general"]`,
`["file", filePath]`, or `["line", filePath, line, side]`. Presentation order is deliberately excluded, so
reordering the finding deck cannot create a duplicate provider comment. The
resolved repository account ID is a server-private provider coordinate used
only in this in-process canonical preimage; raw credentials and local profile
aliases are excluded. Only the 64-character SHA-256 `clientRequestToken` is
sent to and persisted by CodeCommit, and the raw account ID must not appear in
comment content or other public output. File findings post as general
comments with their file anchor in the body because CodeCommit exposes only
general and line comment locations.
Long tree rows retain their complete bounded name instead of losing characters
as nesting grows; use `←`/`→` to pan the file rail when the terminal viewport is
narrower than the hierarchy.

### Web Mode

```bash
codecommit web [--port 3000] [--hostname 127.0.0.1]
```

Web mode accepts only loopback hostnames. On startup it opens an owner URL whose
fragment contains a short-lived, single-use bootstrap token. The token is
exchanged for an HttpOnly SameSite cookie and a separate CSRF proof, then removed
from the address bar; the process-scoped owner secret never enters the URL.
Every `/api/**` route requires the cookie, and mutations additionally require
the same-origin CSRF proof shared across tabs for that loopback origin. Do not
publish or proxy this local HTTP listener onto another network.

The development launcher advertises the Vite origin while proxying bootstrap
and API traffic to the backend with its exact loopback origin. Sandbox iframes
use the alternate loopback hostname (`localhost` versus `127.0.0.1`) because
cookies are host-scoped but not port-scoped; this prevents the owner cookie from
being sent to a sandbox port.

Review sandboxes use a digest-pinned code-server image, a random password, a
non-root user mapped to the workspace owner, dropped Linux capabilities, and a Docker port explicitly bound
to `127.0.0.1`. User-configured host mounts must exist and canonically resolve to children of
`~/.codecommit/sandbox-volumes`, and container targets must be children of
`/home/coder` or the exact `/tmp/.local/share/code-server` runtime data subtree;
the built-in Node, pnpm, and Bun setup presets run without privilege escalation.
AWS credentials, SSH keys, the Docker socket, and broad home or root mounts are
rejected before configuration persistence and again before Docker execution.
The cache directory and database that persist the sandbox password are repaired
to owner-only `0700` and `0600` permissions before use.
The authenticated credential response is non-cacheable, and the UI masks the
password until the owner explicitly reveals or copies it.

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
