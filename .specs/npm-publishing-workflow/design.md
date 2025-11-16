# NPM Publishing Workflow - Design

## GitHub Actions Workflow Architecture

### Workflow File Structure

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}

permissions: {}

jobs:
  release:
    if: github.repository_owner == 'knpkv'
    name: Release
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: write
      id-token: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - name: Install dependencies
        uses: ./.github/actions/setup
      - name: Create Release Pull Request or Publish
        uses: changesets/action@v1
        with:
          version: pnpm changeset-version
          publish: pnpm changeset-publish
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## Integration Patterns

### Existing System Integration

- **Setup Action**: Reuse `./.github/actions/setup` for consistent dependency installation
- **Package Scripts**: Use existing `changeset-version` and `changeset-publish` scripts
- **Workspace Structure**: Leverage existing pnpm workspace configuration
- **Changesets Config**: Use existing `.changeset/` configuration

### Security Model

- **Repository Owner Check**: `if: github.repository_owner == 'knpkv'`
- **Minimal Permissions**: Only required permissions for publishing
- **Token Security**: Use GitHub secrets for npm token
- **No Default Permissions**: Start with `permissions: {}` then grant specific

## Error Handling Strategy

### Workflow Level

- **Timeout Protection**: 30-minute timeout for entire job
- **Concurrency Control**: Prevent multiple releases simultaneously
- **Conditional Execution**: Only run for repository owner

### Step Level

- **Changesets Action**: Built-in error handling for version/publish failures
- **Dependency Installation**: Existing setup action error handling
- **Token Validation**: GitHub Actions validates secret availability

## Testing Strategy

### Workflow Validation

```bash
# GitHub Actions syntax check
act -j release

# Workflow file validation
yamllint .github/workflows/release.yml
```

### Integration Testing

- **Changesets Testing**: Verify changeset files trigger correct behavior
- **Permission Testing**: Test with different repository contexts
- **Build Verification**: Ensure `pnpm changeset-publish` builds successfully

## Documentation Plan

### JSDoc Comments

- **Workflow Documentation**: Inline comments explaining each step
- **Configuration Documentation**: Comments on permission choices
- **Integration Notes**: Comments on how it connects to existing systems

### README Updates

- **Workflow Documentation**: Add to `.github/workflows/README.md`
- **Contributing Guide**: Update with release process information
- **Setup Instructions**: Document required secrets and permissions

## Code Examples

### Changeset File Example

```yaml
# .changeset/fresh-ligers-learn.md
---
"@knpkv/hello": patch
---
Small bug fix to hello package
```

### Release Process Example

1. Developer adds changeset file
2. PR merges to main
3. Release workflow creates Version PR
4. Version PR merges triggers publishing
5. Packages published to npm with GitHub release

## Integration Points

### Existing Workflows

- **Check Workflow**: No conflicts, runs on PRs
- **Snapshot Workflow**: Independent, runs on schedule
- **Release Workflow**: New, runs on main push

### Package Structure

- **Monorepo Support**: Changesets handles multiple packages
- **Build Process**: `changeset-publish` includes build step
- **Version Management**: Changesets manages inter-package dependencies

## Security Considerations

### Permission Model

- **Contents Write**: Needed for release PRs and tags
- **ID Token Write**: Needed for npm provenance
- **Pull Requests Write**: Needed for release PR management

### Secret Management

- **NPM_TOKEN**: Stored in GitHub repository secrets
- **GITHUB_TOKEN**: Automatically provided by Actions
- **No Hardcoded Values**: All sensitive data in secrets

## Performance Optimizations

### Caching Strategy

- **Dependency Cache**: Leverage existing setup action caching
- **Build Artifacts**: Changesets handles build optimization
- **Parallel Execution**: Single job for simplicity and reliability

### Resource Usage

- **Ubuntu Latest**: Standard platform for compatibility
- **Timeout Management**: 30 minutes prevents hanging jobs
- **Concurrency Control**: Prevents resource conflicts

## Monitoring and Observability

### Workflow Logs

- **Step-by-Step Logging**: Each action provides detailed output
- **Error Context**: Changesets action provides specific error messages
- **Success Indicators**: Clear success/failure signals

### Release Tracking

- **GitHub Releases**: Automatic creation with changelog
- **npm Registry**: Package version tracking
- **Repository Activity**: Workflow run history
