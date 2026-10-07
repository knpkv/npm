---
"@knpkv/codecommit-core": minor
"@knpkv/control-center": minor
---

AWS adapters resolve local profiles SSO-first, so old keys in `~/.aws/credentials` no longer shadow `aws sso login`. `@knpkv/codecommit-core/AwsProfileCredentials.js` exports the shared resolver. Control Center's CodePipeline adapter uses the shared resolver; AWS discovery reports sign-in failures as `authentication`, and the setup form asks users to check their profile's credentials or sign-in session instead of showing "unavailable (unavailable)". Failed connection tests and discovery failures are logged with their failure tag and available diagnostic code.
