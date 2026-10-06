---
"@knpkv/codecommit-core": minor
"@knpkv/control-center": minor
---

AWS adapters resolve local profiles SSO-first, so old keys in `~/.aws/credentials` no longer shadow `aws sso login`. `@knpkv/codecommit-core/AwsProfileCredentials.js` exports the shared resolver and a check for static keys shadowing an SSO profile. Control Center's CodePipeline adapter uses it; AWS discovery reports sign-in failures as `authentication` with an optional `static-keys-shadow-sso` cause, and the setup form says what failed and how to fix it instead of "unavailable (unavailable)". Failed connection tests and discovery failures are logged with their failure tag and diagnostic code.
