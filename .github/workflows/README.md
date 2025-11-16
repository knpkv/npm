# GitHub Workflows Documentation

This directory contains automated CI/CD workflows for the @knpkv npm monorepo.

## Workflows Overview

### Check (`check.yml`)

**Purpose**: Main CI workflow that runs quality checks on all code changes.

**Triggers**:

- Pull requests to `main` branch
- Pushes to `main` branch
- Manual workflow dispatch

**Jobs**:

#### Format

- Checks code formatting with Prettier
- Ensures consistent formatting across codebase
- **Command**: `pnpm format`
- **Timeout**: 10 minutes
- **Node Version**: 24.10.0

#### Lint

- Runs ESLint on all TypeScript and JavaScript files
- Ensures code style consistency
- **Command**: `pnpm lint`
- **Timeout**: 10 minutes
- **Node Version**: 24.10.0

#### Types

- Validates TypeScript compilation
- **Command**: `pnpm check`
- **Timeout**: 10 minutes
- **Node Version**: 24.10.0

#### Test

- Runs test suite
- **Command**: `pnpm test`
- **Timeout**: 10 minutes
- **Node Version**: 24.10.0

---

### Snapshot (`snapshot.yml`)

**Purpose**: Creates snapshot releases for testing unreleased changes.

**Triggers**:

- Pushes to `main` branch
- Pull requests to `main` branch
- Manual workflow dispatch

**Condition**: Only runs if repository owner is 'knpkv'

**Jobs**:

#### Snapshot

- Builds all packages
- Creates snapshot releases using `pkg-pr-new`
- Publishes to temporary registry for testing
- **Commands**:
  - `pnpm build` - Build all packages
  - `pnpx pkg-pr-new@0.0.28 publish --pnpm --comment=off ./packages/*`
- **Timeout**: 10 minutes
- **Node Version**: 24.10.0

---

### Release (`release.yml`)

**Purpose**: Automated npm publishing workflow for releasing packages to npm registry.

**Triggers**:

- Pushes to `main` branch

**Condition**: Only runs if repository owner is 'knpkv'

**Security**: Uses minimal required permissions and repository owner restriction

**Jobs**:

#### Release

- Creates release pull requests when changesets are ready
- Publishes packages to npm when release PRs are merged
- Generates GitHub releases with changelog
- **Steps**:
  1. Checkout repository
  2. Install dependencies using existing setup action
  3. Run changesets action for version management and publishing
- **Commands**:
  - `pnpm changeset-version` - Version packages based on changesets
  - `pnpm changeset-publish` - Build and publish packages to npm
- **Timeout**: 30 minutes
- **Required Secrets**:
  - `NPM_TOKEN` - npm authentication token for publishing
  - `GITHUB_TOKEN` - GitHub token for creating releases and PRs

**Release Process**:

1. Developer adds changeset files describing package changes
2. When changesets are ready, workflow creates a Version PR
3. Merging Version PR triggers package publishing
4. Packages are published to npm with GitHub releases

---

## Concurrency Control

All workflows use concurrency groups to cancel in-progress runs when new commits are pushed:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

This prevents resource waste and speeds up CI feedback.

## Customization Guide

### Disabling Specific Jobs

To disable a job, add a condition:

```yaml
jobs:
  job-name:
    if: false # Disables this job
    # ... rest of job config
```

### Adding New Checks

Add new jobs to `check.yml`:

```yaml
jobs:
  new-check:
    name: My Custom Check
    runs-on: ubuntu-latest
    permissions:
      contents: read
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - name: Install dependencies
        uses: ./.github/actions/setup
        with:
          node-version: 24.10.0
      - run: pnpm my-custom-command
```

## Node Version

- **Node.js**: 24.10.0

This can be updated in the workflow file as needed.

## Maintenance

- Review and update Node version periodically
- Monitor workflow execution times and adjust timeouts if needed
- Keep action versions up-to-date (`actions/checkout@v4`, etc.)
