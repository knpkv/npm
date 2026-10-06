---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": minor
---

`AppState.callerIdentities` records who the caller is in every enabled account, keyed by AWS profile. Before, only `currentUser` existed, taken from the first enabled account alone. Each entry is `Resolved` (`accountId`, `arn`, `username`) or `Unresolved` with a typed `reason`: `CredentialsUnavailable`, `StsRejected` or `Throttled` from the identity lookup's error type, or `RefreshAuthFailed` when a pull-request refresh hits an authentication error. `@knpkv/codecommit-core/Domain` exports the `CallerIdentityState`, `CallerIdentityUnresolvedReason` and `CallerIdentities` schemas, and `AwsClient.CallerIdentity` gains `arn`. The codecommit-web event stream sends `callerIdentities`, so the browser can match wildcard approval pools against the caller's exact ARN in each account. SSO login updates that profile's identity; SSO logout marks every account `CredentialsUnavailable`. `currentUser` is unchanged.
