# @knpkv/confluence-api-client

## 0.4.0

### Minor Changes

- [#114](https://github.com/knpkv/npm/pull/114) [`904d3d7`](https://github.com/knpkv/npm/commit/904d3d75948d94558484094cf225b5ea6585663e) Thanks [@konopkov](https://github.com/konopkov)! - Add Jira and Confluence attachment support.

  - Add shared attachment rendering and placeholder replacement helpers.
  - Support multipart attachment upload calls in Jira and Confluence API clients.
  - Render Jira attachments as inline image previews or links with hidden attachment metadata.
  - Resolve Confluence media attachments to visible Markdown previews while preserving native media ADF identity.
  - Add explicit Jira and Confluence attachment upload commands with optional Markdown placeholder insertion.

## 0.3.0

### Minor Changes

- [#71](https://github.com/knpkv/npm/pull/71) [`e3c3805`](https://github.com/knpkv/npm/commit/e3c3805ee527a6edb69ed91977c95c586b563ff9) Thanks [@konopkov](https://github.com/konopkov)! - Migrate the package workspace to Effect v4 beta.

  This updates runtime and peer dependencies to the Effect v4 beta module layout,
  adopts Effect platform/runtime services for Node process, HTTP, filesystem, and
  clock access, and refreshes package export metadata to point published type
  entries at emitted `dist/*.d.ts` declarations.

  CodeCommit packages now use Effect v4-compatible AWS and cache layers, including
  typed `distilled-aws` context services, shared cached-comment decoding, and
  schema-derived config defaults. Jira and Confluence OAuth callback servers bind
  the expected local callback port range again under the Effect v4 Node HTTP
  server layer.

  The retired Claude AI packages have been removed from the workspace.

## 0.2.1

### Patch Changes

- [#61](https://github.com/knpkv/npm/pull/61) [`fc7be8f`](https://github.com/knpkv/npm/commit/fc7be8ffaf5b6b094c7f81551e8ace6f2a8f2c4c) Thanks @konopkov! - feat: add jira-api-client and atlassian-common packages
  - New @knpkv/atlassian-common: shared AST types, serializers, auth, and config
  - New @knpkv/jira-api-client: Effect-based Jira REST API client (openapi-gen)
  - Updated @knpkv/confluence-api-client: regenerated with openapi-gen
  - Updated @knpkv/confluence-to-markdown: use new generated API client

## 0.2.0

### Minor Changes

- [#23](https://github.com/knpkv/npm/pull/23) [`bd5bbf4`](https://github.com/knpkv/npm/commit/bd5bbf4679ae1d41b33182fcca70adf0960f0839) Thanks @konopkov! - feat(confluence-api-client): new package for Confluence Cloud REST API

  New `@knpkv/confluence-api-client` package with Effect-based Confluence Cloud REST API client:
  - V1 API: `/user`, `/content/{id}/property/{key}` endpoints
  - V2 API: Pages CRUD with pagination support
  - Basic auth (email + API token) and OAuth2 (access token + cloud ID)
  - Effect Layer wrapper with config service
  - Daily CI workflow for spec updates

  Migrated `confluence-to-markdown` to use new API client package.
