---
"@knpkv/control-center": patch
---

Failed cleanup, cache writes, lease reads and rollbacks are now logged instead of silently dropped, and an Atlassian sign-in no longer saves when the pre-save snapshot cannot tell whether an auth file exists.
