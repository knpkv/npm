---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": minor
"@knpkv/codecommit": minor
"@knpkv/jira-cli": patch
"@knpkv/confluence-to-markdown": patch
---

Secure local control planes and CI credential boundaries. CodeCommit web now
uses a process-scoped owner session with CSRF protection and loopback-only
listeners; review sandboxes use authenticated loopback code-server instances,
digest-pinned images, constrained mounts, non-root execution, and dropped
capabilities. OAuth callback listeners validate state before accepting terminal
outcomes and bind explicitly to loopback. GitHub workflows pin external actions
to immutable commits and keep long-lived Atlassian credentials out of pull
request execution.
