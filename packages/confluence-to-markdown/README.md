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

# Delete a page from Confluence
confluence delete <pageId> -f         # permanently delete (requires delete:page scope)

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

### Page Creation

```bash
# Create a new page (interactive parent selector)
confluence new

# Workflow:
# 1. Create new page: confluence new
# 2. Edit the file
# 3. Commit: confluence commit -m "Add new page"
# 4. Push to Confluence: confluence push
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

## Git Implementation

### Two-Branch Model

The CLI uses a two-branch model to track sync state:

- **`local`** (current branch): Your working branch for edits
- **`origin/confluence`**: Tracks the remote Confluence state

```
Clone:
  Confluence ──pull──> local + origin/confluence (both at same commit)

Pull:
  Confluence ──pull──> origin/confluence ──merge──> local

Push:
  local ──push──> Confluence
    │
    └──> origin/confluence (updated to HEAD)
```

### Commit Behavior

When you commit:

1. **Sync external docs** (if configured): Copies files from external `docsPath` to `.confluence/`
2. **Stage all changes**: Runs `git add -A`
3. **Create commit**: Records changes with your message

Note: Front-matter (`contentHash`, `version`) is **not** updated at commit time. Changes are detected by comparing actual content hash vs stored hash.

### Push Behavior

When you push:

1. **Detect changes**: Compares content hash vs stored `contentHash` in front-matter
2. **Push to Confluence**: Uploads markdown converted to Confluence storage format
3. **Fetch canonical content**: Downloads what Confluence actually stored (may differ slightly)
4. **Amend commit**: Updates local file with canonical content so future clones match exactly
5. **Update tracking branch**: Moves `origin/confluence` to HEAD

Multiple local commits combine into a single Confluence version (uses last commit's message).

### Content Hash Tracking

Each markdown file has front-matter with a `contentHash` field:

```yaml
---
pageId: "123456"
version: 42
title: My Page
contentHash: 7a8b9c... # SHA-256 of markdown content
---
```

- After clone/pull: `contentHash` matches the actual content
- After local edit: content differs from `contentHash` → detected as "needs push"
- After push: `contentHash` updated to match canonical Confluence content

### Why Canonical Content?

Confluence may transform your content (normalize whitespace, reorder attributes, etc.). By fetching and storing the canonical content after push:

- `clone` on another machine produces **identical** files
- Git history shows exactly what Confluence has
- No false "modified" status from round-trip differences

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
     - `delete:page:confluence` - delete pages (optional)
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
│       ├── page1/       # Children of page1
│       │   └── child.md
│       └── subdir/
│           └── page2.md
└── ...
```

### Page Hierarchy Rules

Directory structure determines Confluence page hierarchy:

- Files in `docs/` root → children of root page
- `foo.md` → page "foo"
- `foo/` directory → contains children of "foo.md"
- `foo/bar.md` → child page of "foo.md"

Example structure:

```
docs/
├── guide.md           # Child of root
├── guide/             # Children of guide.md
│   ├── getting-started.md
│   └── advanced.md
└── reference.md       # Child of root
```

### New Page Front-matter

New pages require only a `title` in front-matter:

```yaml
---
title: "My New Page"
---
Page content here...
```

After pushing, the file is updated with full metadata:

```yaml
---
pageId: "123456"
version: 1
title: "My New Page"
updated: 2024-01-15T10:30:00.000Z
parentId: "789012"
contentHash: "7a8b9c..."
---
```

## Known Limitations

- **Attachments**: Image and file attachments are not synced
- **Comments**: Page comments are not preserved
- **Page deletion**: Deleting local files does not delete pages on Confluence

## License

MIT
