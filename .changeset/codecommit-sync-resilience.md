---
"@knpkv/codecommit-core": patch
"@knpkv/control-center": patch
---

Make CodeCommit manual synchronization resilient to real provider responses.
Pull-request decoding now normalizes untrimmed titles and tolerates omitted
author identities instead of failing the whole stream, and schema-decode
failures are surfaced in logs with the offending field. Reduce the
GetPullRequest hydration fan-out to stay under CodeCommit's throttle ceiling,
and honor a bounded provider Retry-After when retrying rate-limited syncs.
Correct the manual-sync timestamp rendering and show an explicit in-progress
state in the services UI.
