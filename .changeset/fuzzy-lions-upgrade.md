---
"@knpkv/ai-claude": minor
"@knpkv/ai-codex": minor
"@knpkv/ai-runtime": minor
"@knpkv/codecommit": patch
"@knpkv/control-center": minor
"@knpkv/control-center-sql": minor
---

Require Node.js 26 or newer and align the reproducible development, CI, release,
benchmark, and package-validation toolchains with Node.js 26.

Keep the CodeCommit CLI on the current Bun runtime, document that executable
prerequisite, and require its Bun-hosted process boundaries in CI.
