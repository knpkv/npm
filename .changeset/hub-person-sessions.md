---
"@knpkv/herdr-hub": minor
---

Add browser sessions and `herdr-hub login`:

- `/v1/session` logs a Tailscale person in with a `__Host-` cookie, bound to their login and node.
- `herdr-hub login` opens the hub's page logged in as the local user. The page trades a one-time code for a token it sends as a header, never a cookie.
- Only token digests are stored. Sessions survive restarts and last 8 hours (a person's own device renews on use, for up to 7 days).
- Shadow mode now sees session, CLI and local-session callers, and logs a session's write that comes without its CSRF token.

Nothing is enforced yet.
