# CodeCommit web pairing boundary

CodeCommit web owns an ephemeral, process-scoped owner session. Each bind rotates
the owner, CSRF, and bootstrap credentials; the bootstrap credential is valid for
60 seconds, single-use, and limited to five failed unauthenticated attempts. The
owner cookie is HttpOnly and SameSite=Strict. This intentionally differs from
Control Center's durable workspace session (12-hour idle and 30-day absolute
lifetimes); the shared `@knpkv/browser-pairing` package supplies only credential
validation, issuance, hashing, expiry, cookie serialization, and one-time state
transitions. Each application keeps its own persistence and authorization policy.

Origin checks use the configured loopback authority captured at bind time. The
request `Host` header is not an authority source.
