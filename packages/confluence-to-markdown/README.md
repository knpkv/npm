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
confluence workspace clone --root-page-id <ID> --base-url <URL>
confluence workspace clone --url <PAGE_URL>

# Fetch one latest page to stdout without creating a git workspace
confluence page get --page-id <ID> --base-url <URL>
confluence page get --url <PAGE_URL>
confluence page get --url <PAGE_URL> --clean-markdown

# Pull pages from Confluence
confluence sync pull
confluence sync pull -f, --force           # overwrite local changes
confluence sync pull --replay-history      # replay each version as separate git commit

# Push local changes to Confluence
confluence sync push
confluence sync push -n, --dry-run         # preview changes without applying

# Delete a page (interactive selector, deletes local file)
confluence page delete

# Check sync status
confluence sync status
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

# Manage saved accounts/sites
confluence auth profiles
confluence auth use <profile>
confluence auth remove <profile>

# Check auth status
confluence auth status

# Logout
confluence auth logout
```

### Page Creation

```bash
# Create a new page (interactive parent selector)
confluence page new

# Workflow:
# 1. Create new page: confluence page new
# 2. Edit the file
# 3. Commit: confluence sync commit -m "Add new page"
# 4. Push to Confluence: confluence sync push
```

### Page Deletion

```bash
# Delete a page (interactive selector)
confluence page delete

# Workflow:
# 1. Delete page: confluence page delete (or rm <file>)
# 2. Commit: confluence sync commit -m "Delete page"
# 3. Push to Confluence: confluence sync push  # deletes from Confluence
```

### Git Commands

```bash
# Commit current changes
confluence sync commit
confluence sync commit -m "message"

# Show commit history
confluence sync log
confluence sync log -n 5               # last 5 commits
confluence sync log --oneline          # compact format
confluence sync log --since 2024-01-01 # since date

# Show changes in working directory
confluence sync diff
confluence sync diff --staged          # staged changes only
confluence sync diff --commit HEAD~1   # compare with commit
```

## How It Works

1. `confluence workspace clone` creates `.confluence/` directory, initializes git, and pulls pages with full version history
2. `confluence page get` prints the latest markdown for one page without creating `.confluence/` or git commits
3. `confluence sync pull` downloads pages and auto-commits changes
4. `confluence sync pull --replay-history` replays each Confluence version as a separate git commit with original author/date
5. Version messages from Confluence are preserved in markdown front-matter
6. Use standard git commands in `.confluence/` for advanced operations

`clone` and `fetch` accept full page URLs via `--url`, including Confluence paths such as
`https://yoursite.atlassian.net/wiki/spaces/DEV/pages/123456/Page+Title` and shorthand numeric paths such as
`https://yoursite.atlassian.com/123456`.

`confluence page get --clean-markdown` removes Confluence round-trip metadata comments such as `<!-- adf:... -->`
from the printed output. This is intended for readable exports and is not suitable for editing and pushing back to
Confluence.

### Conversion pipeline

This package talks to Confluence Cloud in **Atlassian Document Format (ADF)**:

- **Push (markdown → ADF)** delegates to the official `@atlaskit/editor-markdown-transformer` and `@atlaskit/editor-json-transformer`. Atlassian's own libraries author the JSON we send back to Confluence.
- **Pull (ADF → markdown)** uses an in-package tree walker (`AdfWalker`). The walker covers paragraphs, headings, lists, code blocks, tables, panels, task and decision lists, mentions, emojis, status, dates, expand sections, inline cards, and native Table of Contents macro syntax. Lossy marks (`underline`, `textColor`, `backgroundColor`, `subsup`) fall back to inline HTML; unknown nodes degrade to a placeholder comment plus a logged warning.
- Both directions validate against the canonical `@atlaskit/adf-schema` JSON Schema, so library bugs and remote drift surface as structured errors instead of silent corruption.

When `saveSource` is enabled, the raw ADF JSON is persisted as `<page>.source.json` (pretty-printed) alongside the markdown.

#### Known fidelity limitations

Nodes that survive a pull → edit → push round-trip structurally intact: status (unless its text contains `<`), mentions (with an accountId), native Table of Contents syntax (`[[toc]]`, `[[toc:min=2,max=4]]`), Confluence image/file media identity, and macros (`extension` / `bodiedExtension` / `inlineExtension` — the placeholder comment carries the full macro attrs, including `parameters`, as a base64 blob, and a bodied macro's body is re-attached from the blocks between its `<!-- adf:bodiedExtension … -->` / `<!-- adf:/bodiedExtension -->` markers; a bodied macro inside a table cell keeps only the marker, its body is dropped). TOC macros with unrepresentable attrs such as `localId` or `layout` keep using the exact placeholder form instead of readable syntax. Everything below does **not** fully survive:

- **Attachment media.** Page attachments are resolved through the Confluence attachment API. Image and SVG attachments render as visible Markdown image previews and keep the Confluence `mediaSingle` / `mediaGroup` identity in hidden ADF metadata, so pushes reconstruct native media nodes instead of external images. Non-image attachments render as Markdown links. If Confluence returns a media node without a matching attachment record, the node still degrades to an `<!-- adf:media id=… -->` placeholder plus a logged `MediaWithoutUrl` warning.
- **Media captions.** A pulled `mediaSingle` caption is rendered as an italic line under the media, but pushes back as plain italic text — the structured `caption` node is lost.
- **Link titles.** The official `@atlaskit/editor-markdown-transformer` does not retain link titles when parsing markdown, so `[text](url "title")` round-trips back as `[text](url)`.
- **Table cell merges.** `colspan`/`rowspan` are flattened — GFM tables have no merged cells.

The pull side logs warnings for unknown node types, lossy marks, macro placeholders, and unresolvable media or inline cards.

#### Migrating from earlier versions

Prior versions of this package wrote a `<page>.html` companion file when `saveSource` was enabled; the current version writes `<page>.source.json` instead. Existing `.html` files are harmless and can be removed manually:

```bash
find .confluence/docs -name "*.html" -delete
```

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
2. **Push to Confluence**: Converts markdown to Atlassian Document Format (ADF) via the official `@atlaskit/editor-markdown-transformer` + `@atlaskit/editor-json-transformer`, validated against `@atlaskit/adf-schema`
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
     - `delete:page:confluence` - delete pages
     - `read:attachment:confluence` - resolve page attachments
     - `write:attachment:confluence` - upload page attachments
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
confluence auth login --site https://example.atlassian.net

# Check login status
confluence auth status
confluence auth profiles
confluence auth use <profile>
confluence auth remove <profile>

# Logout
confluence auth logout
```

Each login is saved as an auth profile keyed by Atlassian account and site. `<profile>` may be a profile ID, profile name, site URL, cloud ID, or account ID.

Existing OAuth profiles created before attachment support need a fresh `confluence auth login` after the OAuth app includes the attachment scopes.

### API Token (alternative)

```bash
export CONFLUENCE_API_KEY=your-api-token
export CONFLUENCE_EMAIL=your-email@example.com
```

Generate API token at [Atlassian Account Settings](https://id.atlassian.com/manage-profile/security/api-tokens).

### Security Notes

- OAuth credentials and profiles are stored in `~/.config/atlassian/confluence-to-markdown/` with restricted permissions (0600). Legacy `~/.confluence/auth.json` token files are no longer migrated; run `confluence auth login` to create a profile in the shared Atlassian store. Legacy `~/.confluence/config.json` OAuth client configuration is still migrated on first use.
- Treat these files as sensitive - do not share or commit
- Create separate OAuth apps per developer for team projects
- Tokens auto-refresh; if refresh fails, re-run `confluence auth login`

## Configuration

Initialize configuration with `confluence workspace clone`:

```bash
confluence workspace clone --root-page-id 123456 --base-url https://yoursite.atlassian.net
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

| Option            | Description                                                 | Default            |
| ----------------- | ----------------------------------------------------------- | ------------------ |
| `rootPageId`      | Confluence page ID to sync from                             | Required           |
| `baseUrl`         | Confluence Cloud URL                                        | Required           |
| `spaceKey`        | Optional space key                                          | -                  |
| `docsPath`        | Local path for markdown files                               | `.confluence/docs` |
| `excludePatterns` | Glob patterns to exclude                                    | `[]`               |
| `saveSource`      | Save raw ADF JSON alongside markdown (`<page>.source.json`) | `false`            |
| `trackedPaths`    | Glob patterns for git tracking                              | `["**/*.md"]`      |

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

- **Attachment deletes and renames**: The CLI can upload or update a page attachment and preserve pulled media nodes, but it does not yet delete remote attachments or model attachment renames as first-class operations.
- **Comments**: Page comments are not preserved

## License

MIT
