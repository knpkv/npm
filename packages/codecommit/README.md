# @knpkv/codecommit

CLI and TUI for AWS CodeCommit pull requests.

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

List pull requests.

```bash
codecommit pr list [options]
```

| Option     | Alias | Description            | Default     |
| ---------- | ----- | ---------------------- | ----------- |
| `--profile`| `-p`  | AWS profile            | `default`   |
| `--region` | `-r`  | AWS region             | `us-east-1` |
| `--status` | `-s`  | PR status (OPEN/CLOSED)| `OPEN`      |
| `--all`    | `-a`  | Show all PRs           | `false`     |
| `--repo`   |       | Filter by repository   | -           |
| `--author` |       | Filter by author       | -           |
| `--json`   |       | Output as JSON         | `false`     |

Example:

```bash
# List open PRs (default)
codecommit pr list

# List closed PRs
codecommit pr list --status CLOSED

# List all PRs (open and closed)
codecommit pr list --all

# Filter by repo
codecommit pr list --repo my-repo

# Filter by author
codecommit pr list --author andrey

# JSON output
codecommit pr list --json
```

Output:

```
Found 3 open PR(s):

123  my-repo
    Add feature X
    feature/x → main
    by alice  ✓approved ✓mergeable

124  my-repo
    Fix bug Y
    fix/y → main
    by bob  ✗conflicts
```

With `--all`:

```
Found 5 all PR(s):

123  [OPEN] my-repo
    Add feature X
    ...

120  [CLOSED] my-repo
    Old feature
    ...
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

Example:

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

Example:

```bash
# Print to stdout
codecommit pr export 123 my-repo

# Save to file
codecommit pr export 123 my-repo -o pr-comments.md
```

Output format:

```markdown
# RPS-2585: Add CDK destroy buildspec

**Repository:** tilapia
**Branch:** refs/heads/feat/RPS-2585-destroy-buildspec → refs/heads/main
**Author:** andrey
**Status:** OPEN
**AWS Account:** core-code
**Link:** https://...

## Description

Adds buildspec for CDK destroy operation.

## Comments

### src/file.ts

- **alice** (2024-01-15T10:00:00Z)
  This needs refactoring
  - **bob** (2024-01-15T11:00:00Z)
    Agreed, will fix
    - **alice** (2024-01-15T12:00:00Z)
      Thanks!

### General comments

- **charlie** (2024-01-15T09:00:00Z)
  LGTM overall
```

#### Update PR

Update PR title or description.

```bash
codecommit pr update <pr-id> [options]
```

| Option          | Alias | Description        | Default     |
| --------------- | ----- | ------------------ | ----------- |
| `--title`       | `-t`  | New PR title       | -           |
| `--description` | `-d`  | New PR description | -           |
| `--profile`     | `-p`  | AWS profile        | `default`   |
| `--region`      | `-r`  | AWS region         | `us-east-1` |

Example:

```bash
# Update title
codecommit pr update 123 -t "New title"

# Update description
codecommit pr update 123 -d "Updated description"

# Update both
codecommit pr update 123 -t "New title" -d "New description"
```

## AWS Configuration

Uses standard AWS credential chain. Configure via:

- Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- AWS credentials file (`~/.aws/credentials`)
- IAM role (when running on AWS)

Specify profile with `--profile` or `AWS_PROFILE` env var.

## License

MIT
