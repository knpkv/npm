---
"@knpkv/jira-cli": patch
---

Make the OAuth refresh-token rotation atomic so an interrupted CLI cannot log
the user out.

Atlassian rotates refresh tokens: the refresh response carries a replacement and
the token that was sent is consumed server-side. `refreshTokenImpl` performed
the grant and then persisted the result in a separate, interruptible step, so a
fiber interrupt landing between the two destroyed the credential — the stored
refresh token was already spent, the replacement was never written, and the next
refresh failed with a 4xx. `getAccessToken` treats that failure as an expired
refresh token and deletes the token file, so the user was silently logged out
and had to run `jira auth login` again.

Nothing interrupted it before, which is why this had not surfaced. It becomes
reachable as soon as a caller kills the process: this runs during layer
construction on every CLI invocation, and `@knpkv/jira-clockify`'s nvim
statusline terminates the poll process when the editor closes. The grant and
the persist now share one `Effect.uninterruptible` region.

That region carries its own 30s deadline rather than relying on a caller's, for
two reasons. A caller's `Effect.timeout` would be inert — `timeout` is a race,
and racing an uninterruptible loser means waiting for it anyway. And an
uninterruptible region with no deadline of its own absorbs SIGINT/SIGTERM
entirely, since `NodeRuntime.runMain`'s signal handlers do nothing but interrupt
the main fiber — a hung `jira` command would stop responding to Ctrl-C. The
deadline forked inside the region is itself interruptible, so it does bound it.

Abandoning the round-trip still cannot prove the grant did not land — Atlassian
may consume and rotate the token after we stop listening, and no client-side
deadline changes that. So the deadline is paired with a second rule:
`getAccessToken` no longer deletes the stored token on any `step: "refresh"`
failure. It deletes only on the answers that actually mean the grant is dead —
the provider explicitly reporting `invalid_grant`, on a `400` or a `403` — using
the new `OAuthError.status` and `OAuthError.errorCode` from
`@knpkv/atlassian-common`. Previously a transport error or timeout deleted
the active profile outright, which turned a bad network window into an
unattended silent logout: `JiraApiConfigLive` builds on every CLI invocation,
and jcf's statusline runs one every 30 seconds.

The statuses deliberately left alone matter as much. `429` is the one this most
needs to survive — several `jira`/`jcf` processes on one expired token hit the
endpoint together, one wins the rotation and the rest are rate-limited. `408`
and `425` restate the timeout case. `407` and other middlebox replies never came
from Atlassian at all. `401` and `400 invalid_client` mean the client secret is
wrong, where the fix is `jira auth configure`, not a re-login that would fail
the same way. A bare `403` is left alone too: it is as likely to be a proxy or
WAF as Atlassian revoking anything. An unparseable body is no verdict at all.

Now an incomplete refresh normally costs a retry rather than the session. This
narrows the window rather than closing it: the atomicity is fiber-level, so a
SIGKILL after Atlassian has already rotated the token still loses the
replacement, and the next refresh then legitimately reports `invalid_grant`. No
client-side design can close that window against a hard kill.

Covered by tests: a refresh that never answers and one that is rate-limited both
leave the profile on disk, a `400` removes it, and an interrupt mid-rotation
still persists the replacement token.
