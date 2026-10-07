---
"@knpkv/codecommit-core": minor
"@knpkv/control-center": patch
---

`@knpkv/codecommit-core/AwsCredentialErrors.js` exports the credential-failure classifier that CodeCommit refresh already used. Control Center's CodeCommit and CodePipeline plugins and AWS discovery now use it too, so every adapter treats the same expired, unsigned or rejected sessions as a sign-in problem, including unknown provider errors carrying such a wire tag.
