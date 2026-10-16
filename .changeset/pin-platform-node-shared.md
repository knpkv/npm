---
"@knpkv/agent-skills": patch
"@knpkv/agent-usage": patch
"@knpkv/alchemy-console": patch
"@knpkv/atlassian-common": patch
"@knpkv/codecommit-web": patch
"@knpkv/codecommit": patch
"@knpkv/confluence-to-markdown": patch
"@knpkv/control-center": patch
"@knpkv/herdr-coordinator": patch
"@knpkv/herdr-hub": patch
"@knpkv/herdr-monitor": patch
"@knpkv/jcf-web": patch
"@knpkv/jira-cli": patch
"@knpkv/jira-clockify": patch
---

Pin `@effect/platform-node-shared` to the same release as `effect`. `@effect/platform-node` declares it with a caret range, so a fresh install picked up a newer release that imports `Path.make`, which `effect` 4.0.0 lacks. The CLI then failed at startup with npm or pnpm.
