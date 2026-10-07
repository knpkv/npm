---
"@knpkv/codecommit-core": patch
"@knpkv/codecommit-web": patch
"@knpkv/codecommit": patch
"@knpkv/agent-usage": patch
"@knpkv/jira-clockify": patch
"@knpkv/jcf-web": patch
"@knpkv/control-center": patch
---

Executables linked from the repository (`pnpm link --global`, or `node dist/...`) run under plain Node: workspace packages resolve to their build output instead of TypeScript sources. Published `@knpkv/codecommit-core` now maps its `CacheService.js` and `SandboxService.js` subpaths to the files that exist.
