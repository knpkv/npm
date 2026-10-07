---
"@knpkv/codecommit-core": patch
"@knpkv/codecommit-web": patch
---

A refresh held back by the permission gate no longer reads "PermissionDeniedError:." It now says what is missing and where to fix it: "Couldn't list pull requests in dev (eu-central-1): Not allowed yet: the getPullRequests permission prompt has no answer. Allow it in Settings → Permissions." A provider error with no message is named without a dangling colon.
