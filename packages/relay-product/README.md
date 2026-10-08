# @knpkv/relay-product

Shared Relay dock and typed product adapter for `@knpkv/control-center` and
`@knpkv/codecommit-web`.

The dock owns presentation and selector state. Each product supplies typed
authentication, pull-request lookup, exact-page redirection, and continuation
operations. Pull-request thread identity is stable across new head revisions;
the reviewed head remains explicit conversation metadata.

## Launcher and panel

`RelayProductLauncher` and `RelayProductPanel` are the product chrome on rly's Relay
components (`RelayLauncher`, `RelayPanel`, `RelayTranscript`, `RelayComposer`). Mount
both under one `RelayProductDockProvider`: the launcher in the app header, the panel
once, after it. The panel owns Relay's Ctrl/⌘+J; a second panel under the same provider
throws `RelayProductSummonClaimed`. `minHostWidth` is required: each host states the
narrowest width its own page stays usable at beside a pinned Relay. The pin is offered only
where the viewport allows it; `useRelayProductOpen()` exposes `open` and `pinned`, and the
host renders the panel in its own column while both hold.

A registered pull request opens straight into its conversation. The composer's draft is
keyed by the complete, canonically serialised thread identity, so it survives closing,
reopening and presentation changes, and never sends to another pull request. Messages go
through the unchanged `continuePullRequestConversation` contract. Where every profile
has a model of the same id, one "Run with" preset sets both; a changed preset applies to
the next message, and a selection outside the thread's options keeps Send unavailable
with the reason shown. With no registered pull request, the panel names its
pull-request-only scope and shows the locator. `RelayProductDock` stays exported until
each host migrates.
