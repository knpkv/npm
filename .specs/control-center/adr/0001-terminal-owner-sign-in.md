# ADR 0001: non-destructive terminal owner sign-in

Status: accepted

## Decision

Bare `control-center` reuses a running loopback HTTP server or starts it in the foreground. Explicit `serve` remains a print-only foreground start for services. Reuse requests one fresh login code, prints/opens its URL, exits successfully and leaves that server untouched. A newly started server remains until SIGINT/SIGTERM and follows scoped drain/shutdown. Browser-tab closure and idle time never own server lifetime.

The running server issues a fixed-startup-owner, workspace-scoped pairing code through `AuthRepository.issue`. It uses the existing cryptographic pairing primitive, persists only the SHA-256 digest, and expires at 60 seconds. Existing transactional Auth consumption makes it single-use and creates an ordinary independent browser session. Issuance revokes neither existing sessions nor outstanding codes. The terminal code uses the existing device purpose with no issuing browser session; it requires no database migration.

Authority comes from the owner's private control file, not a second process writing the database. The canonical data root's `web/control.json` persists `{origin, token}` with a `0700` leaf directory and `0600` file. The token is a server-private bearer for `/control/login`, distinct from pairing/session credentials. The shared bearer route takes an application-owned mint callback; Control Center retains durable Auth semantics rather than installing a second OwnerSession system. Invalid bearer, mismatched Origin or Host and drain cannot reach the issuer. The mutation is admitted through ServerLifecycle and bounded to five seconds.

Registration occurs only after the authenticated listener has built. Token-matched scope cleanup cannot erase another server's registration. Configured data roots keep their audited relative-symlink claim and canonical operational-path resolution. The control bearer, file and resolved pathname never cross browser projections or logging/telemetry boundaries.

The credential-bearing URL carries `#bootstrap_token=` and is emitted only to CLI stdout and its browser opener. Before router creation/render, the client replaces the fragment-bearing history entry and retains the code only for one pairing POST. StrictMode mounts share that exchange. Manual `/pair` remains available. HTTP request URLs and referrers omit the fragment; the initial browser navigation contains it until replacement. Neither pairing codes nor control bearers are persisted by the browser.

This flow supports loopback HTTP only. Other modes print `sign in through <configured origin>` and mint nothing. TLS, proxy, Host/Origin, CSRF and insecure-LAN restrictions remain authoritative. The separately terminal-confirmed, ownership-verified and audited `recover-owner` retains its destructive session/code revocation behavior.

## Alternatives

A separate CLI database insert would create another privileged writer and bypass the existing live lifecycle admission. Shared storage primitives do not constitute an authorized terminal channel. Recovery with session revocation disabled still revokes outstanding codes, so it cannot implement non-destructive sign-in. Keeping bare invocation as serve would conflict with the approved local-tool sign-in behavior; explicit serve protects service lifetime.

## Verification

Focused tests protect the behavioral boundary: an existing owner session and outstanding device code remain valid after mint; bearer/Origin/Host rejection leaves the code list unchanged; replay and exact expiry fail; drain refuses issuance; unsupported transports perform no login/open/start; reused invocation returns without serve; started invocation releases its scope only after interruption; fragment replacement precedes one POST under StrictMode. Static source patterns cannot prove preservation of durable credentials.
