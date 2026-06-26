---
"@knpkv/jira-cli": patch
---

Fix `serializeIssue` crashing with `yaml.safeDump is removed in js-yaml 4`. gray-matter's default YAML engine calls js-yaml 3's `safeDump`/`safeLoad`, both removed in js-yaml 4 — which the workspace pins via a security override. The front-matter writer now supplies a custom engine backed by js-yaml 4's `dump`/`load`.
