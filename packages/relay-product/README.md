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
throws `RelayProductSummonClaimed`. `pin` is required and declared per layout:
`{ _tag: "Unavailable" }` until that layout has been measured, or
`{ _tag: "Available", minHostWidth }` naming the narrowest host track its page stays usable at
beside a pinned Relay. An available pin shows only where the viewport allows it;
`useRelayProductOpen()` exposes `open` and `pinned`, and the host renders the panel in its own
column while both hold.

A registered pull request opens straight into its conversation. The composer's draft is
keyed by the complete, canonically serialised thread identity, so it survives closing,
reopening and presentation changes, and never sends to another pull request. Messages go
through the unchanged `continuePullRequestConversation` contract. Where every profile
has a model of the same id, one "Run with" preset sets both; a changed preset applies to
the next message, and a selection outside the thread's options keeps Send unavailable
with the reason shown. With no registered pull request, the panel names its
pull-request-only scope and shows the locator. `RelayProductDock` stays exported until
each host migrates.

## Conversation client

`@knpkv/relay-product/client` is a Relay conversation in the browser, over any product's
`/…/relay` routes, for any `ObjectRef` (not only pull requests). It needs `@knpkv/relay`
beside it (an optional peer): the client imports only its browser-safe `@knpkv/relay/wire`
entry. The other entries don't import it, so a product that doesn't use the client doesn't
install the harness.

```ts
const relay = makeRelayClient({ base: "/v1/relay", origin: window.location.href })
const runtime = ManagedRuntime.make(Layer.merge(FetchHttpClient.layer, BrowserCrypto.layer))
const conversations = makeRelayConversations(relay, runtime)
// In a component:
const state = useRelayConversation(conversations, { product: "herdr", kind: "fleet", id: host })
```

- **One stream per conversation.** `events` is read as server-sent events through
  `HttpClient`, so its status is visible. 401/403 ends it with `Unauthorized`. A dropped or
  refused connection gives `Disconnected`, then reconnects with backoff (up to 30 seconds),
  and the new subscription starts from a Snapshot; a connection that reached its Snapshot
  starts the backoff over. A frame the client can't read ends it with `StreamFailed`. A
  stream that ended this way stays ended until `retry(ref)` reopens it for its current
  readers. However many parts of a page read a conversation, it has one stream, which closes
  when the last reader leaves.
- **State is folded once, in the store.** `foldRelayConversation` turns `RelayClientEvent`s
  into the transcript, the run in flight, tool rows, confirmation cards, the last failure and
  the backend's status. A Snapshot replaces; it never merges. A reader that subscribes late
  gets the current state at once (open cards included), then live events only, so nothing
  one-off replays for it.
- **A person's message is the server's.** It shows when the stream reports it queued
  (`MessageQueued`, or a Snapshot's `queued`) and then placed in the transcript
  (`MessagePlaced`) or withdrawn, never on the send's answer, so a Snapshot can't race a
  send. The page adds only the text of its own sends, since the stream names a queued
  message by its request id; another page's queued message shows with `text: null`.
- **The composer owns the request id.** `newRequestId()` makes one per draft. To retry a
  failed send, pass the same id: the server takes it once, even when the first attempt
  arrived and only its answer was lost.
- **The backend's status is read beside the stream.** The store re-reads it in the
  background after each Snapshot, each run's end and each accepted send, so a failure can
  say "Sign in to Codex" and a slow read never holds back an event. A newer read interrupts
  an older one, and a read still running when the stream closes is interrupted with it.
