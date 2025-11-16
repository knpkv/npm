# NPM Publishing Workflow - Instructions

## Overview and User Story

As a maintainer of this npm monorepo, I want automated npm publishing integrated with GitHub releases so that package updates are published automatically when changesets are merged to main.

## Core Requirements

- Automated npm publishing workflow triggered on main branch pushes
- Integration with existing changesets configuration
- Proper GitHub Actions permissions for publishing
- Support for multiple packages in monorepo
- Release pull request creation and management

## Technical Specifications

- Use changesets/action@v1 for version management and publishing
- Follow Effect-TS publishing patterns from reference implementation
- Integrate with existing pnpm workspace setup
- Use existing setup action for dependency installation
- Configure proper GitHub permissions for publishing

## Acceptance Criteria

- [ ] Workflow triggers on main branch pushes
- [ ] Creates release PRs when changesets are ready
- [ ] Publishes packages to npm when PRs are merged
- [ ] Uses existing pnpm changeset-version and changeset-publish scripts
- [ ] Proper error handling and timeout configuration
- [ ] Only runs for repository owner (security)

## Out of Scope items

- Manual publishing processes
- Package-specific publishing logic (beyond changesets)
- Custom version bumping strategies
- Publishing to other registries (npm only)

## Success Metrics

- Packages are published automatically to npm
- Release PRs are created and managed correctly
- No publishing failures due to workflow configuration
- Security permissions are properly configured

## Future Considerations

- Support for prereleases
- Custom publishing conditions
- Integration with package provenance
- Publishing to additional registries

## Testing Requirements

- Workflow syntax validation
- Permission configuration testing
- Integration testing with changesets
- End-to-end publishing verification
