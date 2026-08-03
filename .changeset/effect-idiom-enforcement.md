---
"@knpkv/atlassian-common": minor
"@knpkv/ai-runtime": patch
"@knpkv/codecommit-core": patch
"@knpkv/codecommit-web": patch
"@knpkv/codecommit": patch
"@knpkv/confluence-to-markdown": patch
"@knpkv/control-center": patch
"@knpkv/jira-cli": patch
"@knpkv/jira-clockify": patch
---

Align runtime ownership, cancellation, caching, time, failure handling, polling,
decoding, and executable entrypoints with Effect v4 idioms. Expose clock-injected
Atlassian token construction and expiry helpers, and enable workspace-wide
Effect diagnostics and prevention checks.
