---
"@knpkv/codecommit": patch
"@knpkv/codecommit-web": patch
"@knpkv/codecommit-core": patch
---

Fix `NotFound: ChildProcess.spawn` when opening a PR in the AWS console or cloning into a review sandbox. `ChildProcess.make` replaces the child environment unless `extendEnv` is set, so passing only `GRANTED_ALIAS_CONFIGURED` or the `AWS_PROFILE` overrides dropped `PATH` and the `assume`, `git`, and `aws` executables could no longer be resolved.

Inheriting the caller's environment also means inheriting its AWS credentials, which the credential chain resolves above profile configuration. Profile-scoped spawns now go through `ChildEnv.profileScopedEnv` so the requested profile and region stay authoritative instead of a sandbox clone silently authenticating as the host's identity.

**Behaviour change.** These ambient variables are now removed from the child environment of the `assume` and sandbox-clone spawns:

- static credentials — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_SECURITY_TOKEN`, `AWS_CREDENTIAL_EXPIRATION`
- web identity — `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_SESSION_NAME`
- region — `AWS_REGION`, `AWS_DEFAULT_REGION`

If you relied on any of these to steer these commands, pass the value explicitly instead; the named profile now decides. `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` are deliberately preserved. `ChildEnv.ts` carries the authoritative list and the reasoning, including a documented Windows case-insensitivity limitation.
