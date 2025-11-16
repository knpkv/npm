# @knpkv Package Collection

A monorepo containing npm packages published under the **@knpkv** scope.

This repository uses [Effect-TS](https://effect.website) for type-safe functional programming patterns and leverages modern tooling for package development and publishing.

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
```

## Resources

- [Effect-TS Documentation](https://effect.website/docs/introduction)
- [GitHub Actions Workflows](.github/workflows/README.md)

## License

MIT
