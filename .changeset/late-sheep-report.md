---
"@knpkv/confluence-to-markdown": patch
---

Fix Confluence link handling and consolidate preprocessing modules

- Handle `<ac:link><ac:link-body>` pattern that was being lost during conversion
- Consolidate duplicate preprocessing code (deleted `parsers/preprocessing/`)
- Remove type assertion casts in favor of Schema.decodeSync
- Fix CI: configure git user.name/email in init for fresh repos
