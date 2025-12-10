# @knpkv/confluence-to-markdown

## 0.4.0

### Minor Changes

- [#21](https://github.com/knpkv/npm/pull/21) [`f696d00`](https://github.com/knpkv/npm/commit/f696d0056de28f2871a48a0caac88b696c86ba68) Thanks @konopkov! - Add git version tracking and CLI improvements
  - Add GitService for git operations with version history replay
  - Add clone command that pulls pages with full version history
  - Flatten git commands: confluence commit/log/diff (was: confluence git ...)
  - Add auth status subcommand
  - Reorganize bin.ts into separate command files
  - Add nice error messages without stack traces
  - Clone fails if already cloned

## 0.3.0

### Minor Changes

- [#19](https://github.com/knpkv/npm/pull/19) [`15b1ff7`](https://github.com/knpkv/npm/commit/15b1ff70e9e7a406ddbc4ce8bcd0673965464421) Thanks @konopkov! - Add OAuth authentication for Confluence Cloud
  - `confluence auth create` - opens Atlassian Developer Console to create OAuth app
  - `confluence auth configure` - save client ID/secret
  - `confluence auth login` - browser-based OAuth flow
  - `confluence auth logout` - remove stored token
  - Show login status in `confluence status`
  - Auto-refresh tokens when expired
  - Use granular scopes for API v2: read:page:confluence, write:page:confluence

## 0.2.1

### Patch Changes

- [#17](https://github.com/knpkv/npm/pull/17) [`879af56`](https://github.com/knpkv/npm/commit/879af56383230d852e1434efb67e6f5cdffd3507) Thanks @konopkov! - Improve type safety and code organization:
  - Add MdastRootSchema with runtime validation
  - Extract preprocessing to separate module
  - Consolidate duplicate mdastToString utility
  - Use exhaustive switch statements

## 0.2.0

### Minor Changes

- [#14](https://github.com/knpkv/npm/pull/14) [`ddb73a3`](https://github.com/knpkv/npm/commit/ddb73a3b2633ec2e531ba2ff3f3a3b55fbadef3a) Thanks @konopkov! - Initial release of confluence-to-markdown package
  - CLI with init/pull/push/sync/status commands
  - Effect-TS based Confluence REST API v2 client
  - Bidirectional markdown sync with frontmatter
  - HTML to GFM conversion via rehype/remark
  - Interactive prompts for missing CLI args
