# @knpkv/confluence-api-client

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
