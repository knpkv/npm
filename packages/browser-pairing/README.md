# @knpkv/browser-pairing

Typed, redacted browser-pairing credentials and transport primitives. Product
packages keep their persisted authorization and application route policy.

`@knpkv/browser-pairing/owner-session` shares the Owner
Session of a single-operator loopback web app. It issues the session, CSRF
(`writes: "csrf"`) and bootstrap credentials, authorizes requests by session
cookie, Origin, Fetch Metadata and CSRF token, and serves `POST /auth/bootstrap`.
The service and its bootstrap response carry credentials; the session cookie is
the only value it sets on the browser. Applications keep their API middleware,
map `OwnerSessionUnauthorizedError` to 401 and `OwnerSessionForbiddenError` to
403, and pass the origin a browser request must carry. Every loopback web app
uses this one owner-session policy, each under its own cookie name.

`PairingCode`, `SessionToken`, and `CsrfToken` are distinct branded roles over
the same validated credential encoding. Consumers must issue and decode the
role they need; the generic `BrowserCredential` is only a pre-role transport
value.

`@knpkv/browser-pairing/launch` shares browser-launch policy and an injectable
`BrowserOpener`. Pass executable-boundary observations to `browserLaunch`:
`noOpen`, `browser`, `ci`, and `interactive`. `--no-open`, `BROWSER=none`, a set
`CI`, or non-terminal stdout skip the browser and retain the skip reason.
`BrowserOpener.layer` uses `ChildProcessSpawner`, trying `open`, `xdg-open`,
then `rundll32.exe` on process failures. Numeric exit codes retain the existing
policy and do not trigger another opener. `openBrowser` treats missing openers
as best effort and emits a fixed warning without subprocess errors or URLs.

Call `openOrServe({ login, serve, launch })` with a login effect returning
`Option<string>` and a foreground `serve(onReady)` effect. A returned URL is
printed to stdout and opened, then the run returns without starting or stopping
that server. Only `None` starts the server; login failures propagate. The
started server calls `onReady` once listening, then stays alive until runtime
interruption, such as SIGINT or SIGTERM. Its scope closes on interruption or
failure. Browser-tab closure and idle time do not stop it.

Both branches print the URL to stdout even when opening is skipped. URLs can
be direct links or credential-bearing bootstrap links from the existing
owner-session mint/bootstrap flow. Keep credential URLs out of errors, logs,
and telemetry in the supplied callbacks. The launcher does not mint, exchange,
or persist credentials, and exposes sanitized `BrowserOpenError` and
`BrowserLaunchOutputError` failures.

Typed cookie serialization accepts only a redacted `SessionToken`; JavaScript
callers still reach the runtime credential and attribute validation boundary.

`@knpkv/browser-pairing/control` shares owner-only control files and the bearer
login route. Call `makeWebControl({ directory, file, messages })` with resolved
paths and optional product-specific error sentences. Its `writeControlFile`,
`registerControlFile`, `removeControlFile` and `requestLoginUrl` operations use
Effect FileSystem, Path and HttpClient services. Register only once the
listener is ready; scope cleanup removes the file only if its token still
matches, leaving a newer server's registration intact.

`ControlFile` persists `{ origin, token }` and is credential-bearing. The
origin is the direct loopback listener; the bearer token and file stay
server-private and owner-only, never in HTTP projections, logs or telemetry.
Directories must be 0700 and files 0600. Linked and permissive paths are
refused, writes use exclusive temporary files and atomic rename, and a shared
exclusive lock serializes publication and removal with stale-lock recovery.
Callers choose a private control directory; unrelated configuration directories
can keep their existing permissions. The helper does not migrate legacy files.

`requestLoginUrl` sends one bearer-authenticated POST to `/control/login`.
`WebNotRunning` covers missing, invalid or unreachable registrations;
`WebLoginRefused` covers refused or malformed replies and must not trigger
another server. Replies must contain a valid one-time bootstrap URL at the
recorded loopback origin or the supported development proxy origin. That URL
is a credential, printed only on CLI stdout and passed to the browser opener.

`loginControlRouter(token, publicOrigin)` uses the existing OwnerSession mint
and bootstrap flow. It returns a non-cacheable credential URL only for the
server-private bearer token, without cookie authentication. Apply
`controlAwareCors(options)` when enabling ordinary application CORS; it
excludes `/control/login` from CORS and preflight while retaining it for other
routes. The application supplies the same public origin as startup.
