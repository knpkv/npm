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

Typed cookie serialization accepts only a redacted `SessionToken`; JavaScript
callers still reach the runtime credential and attribute validation boundary.
