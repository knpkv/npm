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

### API Token

```bash
export CONFLUENCE_API_KEY=your-api-token
export CONFLUENCE_EMAIL=your-email@example.com
```

### Security Notes

- OAuth client credentials are stored in `~/.confluence/config.json` with restricted permissions (0600)
- Treat this file as sensitive - do not share or commit it
- Create separate OAuth apps per developer for team projects
- Tokens are auto-refreshed; if refresh fails, re-run `confluence auth login`

## Configuration

Initialize configuration with `confluence init`:

```bash
confluence init --root-page-id 123456 --base-url https://yoursite.atlassian.net
```

This creates `.confluence.json` in your project root.

## Known Limitations

- **Page creation**: Creating new pages from local markdown is not yet implemented
- **Conflict detection**: Bidirectional sync does not detect conflicts (last write wins)
- **Attachments**: Image and file attachments are not synced
- **Comments**: Page comments are not preserved

## License

MIT
