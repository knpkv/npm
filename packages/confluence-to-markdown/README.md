# @knpkv/confluence-to-markdown

> **Warning**
> This package is experimental and in early development. Code is primarily AI-generated and not yet publicly published. For preview, use snapshot releases.

Sync Confluence Cloud pages to local GitHub Flavored Markdown files with built-in git version tracking.

## Installation

```bash
npm install @knpkv/confluence-to-markdown effect
```

## CLI Usage

### Core Commands

```bash
# Clone pages with full version history
confluence clone --root-page-id <ID> --base-url <URL>

# Pull pages from Confluence
confluence pull
confluence pull -f, --force           # overwrite local changes
confluence pull --replay-history      # replay each version as separate git commit

# Push local changes to Confluence
confluence push
confluence push -n, --dry-run         # preview changes without applying
confluence push -m, --message "msg"   # with revision comment

# Check sync status
confluence status
```

### Authentication Commands

```bash
# Create OAuth app (opens browser to Atlassian Developer Console)
confluence auth create

# Configure OAuth credentials
confluence auth configure --client-id <ID> --client-secret <SECRET>

# Login via browser
confluence auth login
confluence auth login --site <URL>    # for accounts with multiple sites

# Check auth status
confluence auth status

# Logout
confluence auth logout
```

### Git Commands

```bash
# Commit current changes
confluence commit
confluence commit -m "message"

# Show commit history
confluence log
confluence log -n 5               # last 5 commits
confluence log --oneline          # compact format
confluence log --since 2024-01-01 # since date

# Show changes in working directory
confluence diff
confluence diff --staged          # staged changes only
confluence diff --commit HEAD~1   # compare with commit
```

## How It Works

1. `confluence clone` creates `.confluence/` directory, initializes git, and pulls pages with full version history
2. `confluence pull` downloads pages and auto-commits changes
3. `confluence pull --replay-history` replays each Confluence version as a separate git commit with original author/date
4. Version messages from Confluence are preserved in markdown front-matter
5. Use standard git commands in `.confluence/` for advanced operations

## Authentication

### OAuth (recommended)

#### 1. Create OAuth App

1. Go to [Atlassian Developer Console](https://developer.atlassian.com/console/myapps/)
2. Click **Create** → **OAuth 2.0 integration**
3. Enter app name (e.g., "Confluence CLI")
4. Configure permissions in **Permissions** tab:
   - Add **Confluence API** with scopes:
     - `read:page:confluence` - read pages
     - `write:page:confluence` - push changes
   - Add **User Identity API**:
     - `read:me` - get current user info
5. In **Authorization** tab, set callback URL: `http://localhost:8585/callback`
6. In **Settings** tab, copy **Client ID** and **Secret**

#### 2. Configure and Login

```bash
# Configure with your client ID and secret
confluence auth configure --client-id <ID> --client-secret <SECRET>

# Login via browser
confluence auth login

# Check login status
confluence status

# Logout
confluence auth logout
```

### API Token (alternative)

```bash
export CONFLUENCE_API_KEY=your-api-token
export CONFLUENCE_EMAIL=your-email@example.com
```

Generate API token at [Atlassian Account Settings](https://id.atlassian.com/manage-profile/security/api-tokens).

### Security Notes

- OAuth credentials stored in `~/.confluence/` with restricted permissions (0600)
- Treat these files as sensitive - do not share or commit
- Create separate OAuth apps per developer for team projects
- Tokens auto-refresh; if refresh fails, re-run `confluence auth login`

## Configuration

Initialize configuration with `confluence clone`:

```bash
confluence clone --root-page-id 123456 --base-url https://yoursite.atlassian.net
```

This creates `.confluence/config.json` in your project root:

```json
{
  "rootPageId": "123456",
  "baseUrl": "https://yoursite.atlassian.net",
  "docsPath": ".confluence/docs",
  "excludePatterns": [],
  "saveSource": false,
  "trackedPaths": ["**/*.md"]
}
```

### Configuration Options

| Option            | Description                           | Default            |
| ----------------- | ------------------------------------- | ------------------ |
| `rootPageId`      | Confluence page ID to sync from       | Required           |
| `baseUrl`         | Confluence Cloud URL                  | Required           |
| `spaceKey`        | Optional space key                    | -                  |
| `docsPath`        | Local path for markdown files         | `.confluence/docs` |
| `excludePatterns` | Glob patterns to exclude              | `[]`               |
| `saveSource`      | Save original HTML alongside markdown | `false`            |
| `trackedPaths`    | Glob patterns for git tracking        | `["**/*.md"]`      |

## Directory Structure

```
project/
├── .confluence/
│   ├── config.json      # Configuration file
│   ├── .git/            # Git repository for version tracking
│   └── docs/            # Synced markdown files
│       ├── page1.md
│       └── subdir/
│           └── page2.md
└── ...
```

## Known Limitations

- **Page creation**: Creating new pages from local markdown is not yet implemented
- **Attachments**: Image and file attachments are not synced
- **Comments**: Page comments are not preserved

## License

MIT
