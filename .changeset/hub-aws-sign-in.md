---
"@knpkv/herdr-hub": minor
---

The hub signs in to AWS itself: `makeAwsSignIn` runs the IAM Identity Center device code sign-in, keeps its tokens in a private database instead of `~/.aws`, and refreshes them; `awsRoleCredentials` turns that sign-in into `Credentials` for one account and permission set. Both are exported from `@knpkv/herdr-hub/hostd-runtime`.
