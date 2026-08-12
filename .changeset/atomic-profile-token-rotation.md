---
"@knpkv/atlassian-common": minor
---

Add `OAuthError.status` and `OAuthError.errorCode`, and make
`refreshActiveProfiles`' token rotation atomic and bounded.

`OAuthError` now carries the HTTP `status` when the provider actually answered,
plus the OAuth 2.0 `errorCode` from the response body (RFC 6749 §5.2) when it is
parseable. Both are absent for transport failures, timeouts and interruptions —
cases where no response arrived and nothing can be concluded about the
credential. `refreshToken` populates them on a non-2xx response.

They exist so callers can tell "the provider rejected this token" from "we never
found out", which is the difference between correctly forcing a re-login and
destroying a working credential. Status alone is too coarse: `400` covers
`invalid_client` and `invalid_request`, which indict the request rather than the
token, so `@knpkv/jira-cli` and `@knpkv/confluence-to-markdown` delete only on
`400 invalid_grant` or a `403` revocation, leaving `429`, `408`, middlebox
replies and unparseable bodies alone.

`refreshActiveProfiles` performed the same rotate-then-persist sequence as
`@knpkv/jira-cli`'s `JiraAuth`: `refreshToken(...)` followed by a separate,
interruptible `saveProfileToken(...)`. Atlassian rotates refresh tokens, so an
interrupt between the two spends the stored credential without persisting its
replacement, and the next refresh fails — the user is silently logged out of
that profile. The grant and the persist now share one `Effect.uninterruptible`
region.

That region carries its own 30s deadline. An uninterruptible region with no
bound of its own absorbs SIGINT/SIGTERM entirely, since `runMain`'s handlers do
nothing but interrupt the main fiber, so `atlassian auth refresh` would have
stopped answering Ctrl-C against a stalled token endpoint. A deadline forked
inside the region is itself interruptible, so it does bound it.

Covered by a test asserting an interrupt mid-rotation still persists the
replacement token.
