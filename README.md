# @knpkv Package Collection

> **Warning**
> This project is experimental and in early development. Code is primarily AI-generated and not yet publicly published. For preview, use snapshot releases.

A monorepo containing npm packages published under the **@knpkv** scope.

This repository uses [Effect-TS](https://effect.website) for type-safe functional programming patterns and leverages modern tooling for package development and publishing.

## Packages

| Package                                                                              | Description                                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| [@knpkv/codecommit](./packages/codecommit)                                           | TUI for browsing AWS CodeCommit PRs                     |
| [@knpkv/codecommit-core](./packages/codecommit-core)                                 | Core logic for CodeCommit PR browser                    |
| [@knpkv/codecommit-web](./packages/codecommit-web)                                   | Web server and frontend for CodeCommit PR browser       |
| [@knpkv/confluence-api-client](./packages/confluence-api-client)                     | Effect-based Confluence Cloud REST API client (v1 + v2) |
| [@knpkv/confluence-to-markdown](./packages/confluence-to-markdown/README.md)         | Sync Confluence Cloud pages to local markdown           |
| [@knpkv/effect-ai-claude-code-cli](./packages/effect-ai-claude-code-cli/README.md)   | Effect-TS wrapper for Claude Code CLI                   |
| [@knpkv/effect-ai-claude-agent-sdk](./packages/effect-ai-claude-agent-sdk/README.md) | Effect-TS wrapper for Claude Agent SDK                  |

### CodeCommit Package Stack

```
codecommit-core         — Domain, services, AWS client, local SQLite cache
  ├── AwsClient         — AWS CodeCommit API (distilled-aws)
  ├── CacheService      — Local SQLite via @effect/sql-libsql (Turso)
  │   ├── PullRequestRepo, CommentRepo, NotificationRepo
  │   ├── SubscriptionRepo, SyncMetadataRepo
  │   └── EventsHub (PubSub-based change notifications)
  ├── ConfigService     — User config (accounts, auto-refresh)
  └── PRService         — Orchestration (refresh, subscriptions, diffs)

codecommit              — TUI (Ink/React) → imports codecommit-core
codecommit-web          — Web server (Bun + HttpApi) + React SPA → imports codecommit-core
```

Both `codecommit` (TUI) and `codecommit-web` share `codecommit-core` services. Client-side code uses deep subpath imports (`@knpkv/codecommit-core/Domain.js`) to avoid pulling in server-only deps.

## Repository Structure

```
npm/
├── packages/          # Published npm packages
├── .github/          # CI/CD workflows for automated checks
└── scripts/          # Build and maintenance scripts
```

## Quick Start

### Prerequisites

- Node.js 24+
- pnpm 9+
- (Optional) Nix with direnv for reproducible dev environment

### Installation

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Type check
pnpm check

# Lint
pnpm lint
```

### Development Environment

This repository uses [Nix flakes](https://nixos.wiki/wiki/Flakes) with [direnv](https://direnv.net) for reproducible development environments:

```bash
# Allow direnv (first time only)
direnv allow

# Environment will auto-load when entering directory
```

## Development Standards

All packages in this repository follow:

- **Effect-TS patterns** - Functional, type-safe error handling
- **TypeScript strict mode** - Zero tolerance for `any` types
- **Comprehensive testing** - @effect/vitest for Effect-based tests
- **Changesets** - Semantic versioning and changelog generation
- **CI/CD automation** - Automated checks, tests, and releases

## Publishing

Packages are published to npm under the [@knpkv scope](https://www.npmjs.com/org/knpkv).

### Creating a Release

1. Create changes with proper documentation and tests
2. Add changeset: `pnpm changeset`
3. Commit changes
4. CI will create version PR automatically
5. Merge version PR to publish

## Available Commands

```bash
# Package management
pnpm install             # Install dependencies
pnpm build               # Build all packages
pnpm test                # Run all tests
pnpm check               # TypeScript type checking
pnpm lint                # Lint code
pnpm lint:fix            # Fix linting issues
pnpm format              # Check formatting
pnpm format:fix          # Fix formatting

# Versioning
pnpm changeset           # Create a changeset
pnpm changeset version   # Update versions (CI only)

# Agent Management
npx @iannuttall/dotagents  # Sync agent commands
```

## Resources

- [Effect-TS Documentation](https://effect.website/docs/introduction)
- [GitHub Actions Workflows](.github/workflows/README.md)

## License

MIT
