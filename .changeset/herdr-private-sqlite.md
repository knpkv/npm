---
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-approvals": patch
"@knpkv/herdr-work": patch
"@knpkv/herdr-connect": patch
"@knpkv/herdr-coordinator": patch
---

Every `node:sqlite` Herdr store now opens its database through the new `@knpkv/herdr-fleet/sqlite` opener. An existing group/other-writable state directory or database is now refused at startup and left unchanged; previously the approval store quietly restricted it before Work could refuse it, and `jobs.sqlite` was never checked. `WorkStore.open` now restricts an existing state directory to `0700`, as the other stores already did. The coordinator's orchestrator database reuses the shared path checks with no behaviour change.
