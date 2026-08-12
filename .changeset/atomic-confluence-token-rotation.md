---
"@knpkv/confluence-to-markdown": patch
---

Apply the same OAuth rotation hardening as `@knpkv/jira-cli` to
`ConfluenceAuth`, which is built on the same shared `refreshToken` and carried
both halves of the defect.

`refreshTokenImpl` did an interruptible rotate-then-persist with no deadline.
Atlassian rotates refresh tokens, so an interrupt between the grant and the save
spends the credential without storing its replacement and silently logs the user
out; an unbounded stall hung the command indefinitely. Grant and persist are now
one `Effect.uninterruptible` region with its own 30s deadline inside it — inside,
because an uninterruptible region with no bound of its own also absorbs
SIGINT/SIGTERM and would leave `confluence` ignoring Ctrl-C.

`getAccessToken` also deleted the stored token on any `step: "refresh"` failure,
so a timeout, a transport error, a `429`, or a `400 invalid_client` from a
rotated client secret all logged the user out unrecoverably. It now deletes only
on `400 invalid_grant` or a `403` revocation, using `OAuthError.status` and
`OAuthError.errorCode` from `@knpkv/atlassian-common`.
