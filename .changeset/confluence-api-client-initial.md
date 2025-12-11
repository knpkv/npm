---
"@knpkv/confluence-api-client": minor
"@knpkv/confluence-to-markdown": patch
---

feat(confluence-api-client): new package for Confluence Cloud REST API

New `@knpkv/confluence-api-client` package with Effect-based Confluence Cloud REST API client:

- V1 API: `/user`, `/content/{id}/property/{key}` endpoints
- V2 API: Pages CRUD with pagination support
- Basic auth (email + API token) and OAuth2 (access token + cloud ID)
- Effect Layer wrapper with config service
- Daily CI workflow for spec updates

Migrated `confluence-to-markdown` to use new API client package.
