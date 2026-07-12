---
"@knpkv/jira-api-client": major
"@knpkv/confluence-api-client": major
"@knpkv/jira-cli": patch
"@knpkv/jira-clockify": patch
"@knpkv/confluence-to-markdown": patch
---

Replace the legacy Atlassian `openapi-fetch` clients with generated,
Schema-validated Effect clients. Jira and Confluence now provide direct Effect
operations, injected `HttpClient` transports, deterministic local regeneration,
structural upstream freshness checks, and scheduled tested update pull requests.

The legacy `toEffect`, `FetchClientError`, raw `.client` operation surface, and
type-only generated subpaths are removed.
