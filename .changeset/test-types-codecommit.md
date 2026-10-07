---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": patch
---

The test suites of codecommit-core and codecommit-web are now typechecked as part of `check`, and both packages leave the test-typecheck allowlist. `PullRequestRepo` exports `StaleOpenRow`, the schema of a stale-open read, so a test can build one from a cached row.
