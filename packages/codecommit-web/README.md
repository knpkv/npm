# CodeCommit web pairing boundary

CodeCommit web owns an ephemeral, process-scoped owner session. Each bind rotates
the owner, CSRF, and bootstrap credentials; the bootstrap credential is valid for
60 seconds, single-use, and limited to five failed unauthenticated attempts. The
owner cookie is HttpOnly and SameSite=Strict. This intentionally differs from
Control Center's durable workspace session (12-hour idle and 30-day absolute
lifetimes). The policy is the shared single-operator Owner Session from
`@knpkv/browser-pairing/owner-session` (ADR-0008); CodeCommit web keeps its API
middleware, wire errors, `cc_owner` cookie name, and dev-proxy model.

Origin checks use the configured loopback authority captured at bind time. The
request `Host` header is not an authority source. Browser reads that Fetch
Metadata marks as cross-site, or as same-site/`none` without the bound Origin,
are refused; explicit clients without Fetch Metadata still need the owner
cookie.

The authenticated event stream carries `callerIdentities`, the caller's identity
per configured account and keyed by AWS profile. Each entry is either `Resolved`
(`accountId`, `arn`, `username`) or `Unresolved` with a typed `reason`
(`CredentialsUnavailable`, `StsRejected`, `Throttled` or `RefreshAuthFailed`). It gives the client what it needs to match wildcard approval pools (`…/Reviewers/*`)
against the exact `arn` of the account a pull request lives in. That ARN is a client-visible identifier:
for SSO sessions its last segment is usually the person's email. It travels only
to the owner it describes, over the owner-cookie-authenticated stream. It is never
logged, never served on unauthenticated routes, and the browser keeps it only in
its in-memory snapshot. Reasons carry no provider message; the account's
notification explains the failure.
