# @knpkv/confluence-api-client

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
