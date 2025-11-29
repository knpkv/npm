# Gemini Code Understanding

This document provides a comprehensive overview of the `@knpkv` package collection, a monorepo for npm packages. It's designed to be a quick-start guide for developers and a context file for AI assistants.

## Project Overview

This is a `pnpm` workspace-based monorepo containing `npm` packages published under the `@knpkv` scope. The project is built with TypeScript and leverages [Effect-TS](https://effect.website) for robust, type-safe functional programming.

### Key Technologies

- **pnpm Workspaces**: Manages the monorepo structure.
- **TypeScript**: The primary programming language.
- **Effect-TS**: Used for functional programming patterns and error handling.
- **Vitest**: The testing framework.
- **ESLint and Prettier**: For code linting and formatting.
- **Changesets**: For versioning and changelog generation.
- **Nix and direnv**: For reproducible development environments.

### Repository Structure

The repository is organized as follows:

```
npm/
├── packages/          # Published npm packages
├── .github/          # CI/CD workflows for automated checks
└── scripts/          # Build and maintenance scripts
```

## Building and Running

The following commands are essential for working with this project.

### Installation

Install all dependencies using `pnpm`:

```bash
pnpm install
```

### Core Commands

- **Build all packages**:

  ```bash
  pnpm build
  ```

- **Run all tests**:

  ```bash
  pnpm test
  ```

- **Type-check all packages**:

  ```bash
  pnpm check
  ```

- **Lint all packages**:

  ```bash
  pnpm lint
  ```

- **Format all packages**:
  ```bash
  pnpm format
  ```

## Development Conventions

This project adheres to a strict set of development standards to ensure code quality and consistency.

### Coding Style

- **Functional Programming**: Code is written using functional programming principles, with a strong emphasis on the Effect-TS library.
- **Type Safety**: TypeScript's `strict` mode is enabled, and the `any` type is disallowed.
- **Modularity**: The monorepo is divided into individual packages, each with a specific purpose.

### Testing

- **Comprehensive Tests**: All packages are expected to have comprehensive tests written with `@effect/vitest`.
- **Test-Driven Development**: While not explicitly stated, the emphasis on testing suggests that TDD is a recommended practice.

### Versioning and Publishing

- **Semantic Versioning**: The project uses [Changesets](https://github.com/changesets/changesets) to manage versioning and generate changelogs.
- **Automated Releases**: The CI/CD pipeline automates the release process. When a version PR is merged, the packages are automatically published to `npm`.

### Contribution Guidelines

1.  Create changes with proper documentation and tests.
2.  Add a changeset by running `pnpm changeset`.
3.  Commit your changes.
4.  The CI will create a version PR automatically.
5.  Merge the version PR to publish the changes.

<!-- effect-solutions:start -->

## Effect Solutions Usage

The Effect Solutions CLI provides curated best practices and patterns for Effect TypeScript. Before working on Effect code, check if there's a relevant topic that covers your use case.

- `pnpm effect-solutions list` - List all available topics
- `pnpm effect-solutions show <slug...>` - Read one or more topics
- `pnpm effect-solutions search <term>` - Search topics by keyword

**Local Effect Source:** The Effect repository is cloned to `~/.local/share/effect-solutions/effect` for reference. Use this to explore APIs, find usage examples, and understand implementation details when the documentation isn't enough.

<!-- effect-solutions:end -->
