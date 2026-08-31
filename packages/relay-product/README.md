# @knpkv/relay-product

Shared Relay dock and typed product adapter for `@knpkv/control-center` and
`@knpkv/codecommit-web`.

The dock owns presentation and selector state. Each product supplies typed
authentication, pull-request lookup, exact-page redirection, and continuation
operations. Pull-request thread identity is stable across new head revisions;
the reviewed head remains explicit conversation metadata.
