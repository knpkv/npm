# @knpkv/browser-pairing

Typed, redacted browser-pairing credentials and transport primitives. Product
packages keep their own persistence, persisted authorization, and route policy.

`@knpkv/browser-pairing/owner-session` is the one shared policy: the Owner
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
