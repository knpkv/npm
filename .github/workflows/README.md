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

#### Audit

- Runs pnpm dependency vulnerability audit
- Fails the workflow when audited dependencies include advisories
- **Command**: `pnpm run audit`
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

#### Browser

- Installs the Playwright-managed Chromium runtime and its system dependencies
- Runs the `rly` Storybook interaction, accessibility, static-catalog, and visual-state checks
- Serializes browser work to one worker through the package configuration
- **Command**: `pnpm --filter @knpkv/rly test:browser`
- **Timeout**: 15 minutes
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
  - `sfw pnpm dlx pkg-pr-new@0.0.28 publish --pnpm --comment=off ./packages/*`
- **Timeout**: 10 minutes
- **Node Version**: 24.10.0

---

### Clockify API Spec Check (`clockify-api-update.yml`)

**Purpose**: Detect upstream Clockify OpenAPI changes and open a tested client-regeneration pull request.

**Triggers**:

- Daily at 07:00 UTC
- Manual workflow dispatch

**Pipeline**:

1. Regenerate from the current upstream document; operational failures fail the job.
2. Continue only when the raw spec or generated client differs from the repository.
3. Build both `clockify-api-client` and its `jira-clockify` consumer.
4. Run both packages' test suites.
5. Add a patch changeset and create/update `chore/clockify-api-spec-update`.

The regeneration contract and local review commands are documented in
`packages/clockify-api-client/README.md`.

---

### Jira API Spec Check (`jira-api-update.yml`)

**Purpose**: Detect structural changes to Atlassian's Jira OpenAPI document and open a tested regeneration pull request.

**Pipeline**:

1. Regenerate from the complete upstream document; operational failures fail the job.
2. Continue only when the raw spec or generated client differs from the repository.
3. Build and test `jira-api-client`, `jira-cli`, and `jira-clockify`.
4. Add release changesets and create/update `chore/jira-api-spec-update`.

The generator also normalizes bodyless error responses so non-success statuses
remain failures in the typed Effect error channel. Offline regeneration and the
patch policy are documented in `packages/jira-api-client/README.md`.

---

### Confluence API Spec Check (`confluence-api-update.yml`)

**Purpose**: Detect structural changes to both Confluence OpenAPI documents and open a tested regeneration pull request.

**Pipeline**:

1. Regenerate from both complete upstream documents; operational failures fail the job.
2. Continue only when a raw spec or generated client differs from the repository.
3. Build and test `confluence-api-client` and `confluence-to-markdown`.
4. Add release changesets and create/update `chore/confluence-api-spec-update`.

The comparison deliberately does not trust `info.version`: Atlassian's
Confluence documents can change while continuing to report `1.0.0` and
`2.0.0`. See `packages/confluence-api-client/README.md` for offline
regeneration and patch-review instructions.

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
  - `pnpm changeset:version` - Version packages based on changesets
  - `pnpm changeset:publish` - Build and publish packages to npm
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

## Dependency Install Protection

Dependency installs run through Socket Firewall in `.github/actions/setup`.
The Socket action is pinned to an immutable commit SHA and kept current by
Dependabot. The setup action intentionally does not restore a pnpm dependency
cache, because Socket Firewall can only block package artifacts that are fetched
through the network.

Socket for GitHub is configured by `socket.yml` at the repository root. The
Socket GitHub App still needs to be installed for the `knpkv` repository or
organization in GitHub, and its check should be added to branch protection once
it is reporting reliably.

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
      - uses: actions/checkout@v7
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
