---
"@knpkv/control-center": minor
---

Timeline CSV and JSON exports are now `POST` requests that require an allowed `Origin` and the session's CSRF token. Each download records an export audit row, so it can no longer be triggered by a cross-site `GET`. API clients must switch `exportCsv` and `exportJson` calls to the mutation client.
