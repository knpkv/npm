---
"@knpkv/control-center": patch
"@knpkv/codecommit": patch
---

The remaining byte-capped readers (request bodies, CodePipeline artifacts, PR review source and sandbox output, local Git blobs and Relay patches) now use `@knpkv/bounded-io`. Limits and errors are unchanged; collection is linear instead of quadratic where it was not already.
