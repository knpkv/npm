---
"@knpkv/herdr-hub": minor
---

A reset no longer starts while the hub is signed out of AWS: a release, retry or lift fails as `ResetNeedsSignIn` with the account unchanged, and the sweep waits to expire a lease or resume a reset until the hub is signed in, instead of quarantining the account.
