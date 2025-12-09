# @knpkv/confluence-to-markdown

> **Warning**
> This package is experimental and in early development. Code is primarily AI-generated and not yet publicly published. For preview, use snapshot releases.

Sync Confluence Cloud pages to local GitHub Flavored Markdown files.

## Installation

```bash
npm install @knpkv/confluence-to-markdown effect
```

## CLI Usage

```bash
# Initialize configuration
confluence init --root-page-id 123456 --base-url https://yoursite.atlassian.net

# Pull pages from Confluence
confluence pull
confluence pull --force  # overwrite local changes

# Push local changes to Confluence
confluence push
confluence push --dry-run  # preview changes
confluence push --message "Update docs"  # with revision comment

# Bidirectional sync
confluence sync

# Check sync status
confluence status
```

## Authentication

### OAuth (recommended)

```bash
# 1. Create OAuth app in Atlassian Developer Console
confluence auth create

# 2. Configure with your client ID and secret
confluence auth configure --client-id <ID> --client-secret <SECRET>

# 3. Login via browser
confluence auth login

# Check login status
confluence status

# Logout
confluence auth logout
```

### API Token (legacy)

```bash
export CONFLUENCE_API_KEY=your-api-token
export CONFLUENCE_EMAIL=your-email@example.com
```

## Configuration

Create `.confluence.json` in your project root:

```json
{
  "rootPageId": "123456",
  "baseUrl": "https://yoursite.atlassian.net",
  "spaceKey": "DEV",
  "docsPath": ".docs/confluence"
}
```

## Known Limitations

- **Page creation**: Creating new pages from local markdown is not yet implemented
- **Conflict detection**: Bidirectional sync does not detect conflicts (last write wins)
- **Attachments**: Image and file attachments are not synced
- **Comments**: Page comments are not preserved

## License

MIT
