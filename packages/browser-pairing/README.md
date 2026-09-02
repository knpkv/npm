# @knpkv/browser-pairing

Typed, redacted browser-pairing credentials and transport primitives. Product
packages keep their own persistence, authorization, and route policy.

`PairingCode`, `SessionToken`, and `CsrfToken` are distinct branded roles over
the same validated credential encoding. Consumers must issue and decode the
role they need; the generic `BrowserCredential` is only a pre-role transport
value.

Typed cookie serialization accepts only a redacted `SessionToken`; JavaScript
callers still reach the runtime credential and attribute validation boundary.
