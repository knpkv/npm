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

# Push local changes to Confluence
confluence push

# Bidirectional sync
confluence sync

# Check sync status
confluence status
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

## Environment Variables

```bash
export CONFLUENCE_API_KEY=your-api-token
export CONFLUENCE_EMAIL=your-email@example.com
```

## License

MIT
