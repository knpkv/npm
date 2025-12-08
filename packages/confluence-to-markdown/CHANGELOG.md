# @knpkv/confluence-to-markdown

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
