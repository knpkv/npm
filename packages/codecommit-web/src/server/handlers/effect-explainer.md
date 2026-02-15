# Effect Explainer: Server Handlers

Handler patterns — Schema-encoded SSE via SubscriptionRef, typed error propagation to HTTP responses.

## Handler Map

| File                               | Endpoint                          | Pattern                                                                        |
| ---------------------------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| `prs-live.ts`                      | `/api/prs/*`                      | Read SubscriptionRef, forkDaemon refresh, create PR, search FTS5, comments     |
| `config-live.ts`                   | `/api/config/*`                   | Load/save/validate/reset config, merge with runtime state                      |
| `accounts-live.ts`                 | `/api/accounts`                   | Filter enabled accounts from state                                             |
| `events-live.ts`                   | `/api/events/`                    | SSE — `handleRaw` + `HttpServerResponse.stream` from `SubscriptionRef.changes` |
| `notifications-live.ts`            | `/api/notifications/*`            | List/clear notifications, SSO login/logout via `Command`                       |
| `subscriptions-live.ts`            | `/api/subscriptions/*`            | Subscribe/unsubscribe PRs, list subscriptions                                  |
| `persistent-notifications-live.ts` | `/api/notifications/persistent/*` | DB-backed notifications: list, count, mark read                                |

## Read-Only Handlers: SubscriptionRef Snapshot

Most handlers follow the same pattern — get a snapshot of current state:

```typescript
// accounts-live.ts
HttpApiBuilder.handle("list", () =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.get(prService.state)
    return Chunk.fromIterable(
      state.accounts.filter((a) => a.enabled).map((a) => new Domain.Account({ profile: a.profile, region: a.region }))
    )
  })
)
```

`SubscriptionRef.get` returns the current value without subscribing to changes.
For one-shot HTTP responses, this is correct — no need for a persistent subscription.

## Config Handler: Multi-Service Composition

```typescript
// config-live.ts — combines two services, 5 endpoints
handlers
  .handle("list", () =>
    Effect.gen(function*() {
      const config = yield* configService.load.pipe(
        Effect.catchAll(() =>
          Effect.succeed({ accounts: [], autoDetect: true, autoRefresh: true, refreshIntervalSeconds: 300 }))
      )
      const state = yield* SubscriptionRef.get(prService.state)
      return {
        accounts: config.accounts.map((a) => ({ profile: a.profile, regions: a.regions, enabled: a.enabled })),
        autoDetect: config.autoDetect,
        autoRefresh: config.autoRefresh,
        refreshIntervalSeconds: config.refreshIntervalSeconds,
        currentUser: state.currentUser
      }
    }))
  .handle("save", ({ payload }) => /* save + trigger refresh */)
  .handle("reset", () => /* backup + reset + refresh */)
  // + path, validate
```

Pattern: yield multiple services, compose their data, return merged result.
Error handling: `catchAll` provides a safe default if config fails to load.

## PR Handlers: Read + Write

```typescript
// prs-live.ts — services resolved once in Effect.gen, handlers chained on returned value
export const PrsLive = HttpApiBuilder.group(CodeCommitApi, "prs", (handlers) =>
  Effect.gen(function* () {
    const prService = yield* PRService.PRService
    const awsClient = yield* AwsClient.AwsClient

    return (
      handlers
        // Read: snapshot of current PRs (returns Chunk)
        .handle("list", () =>
          SubscriptionRef.get(prService.state).pipe(Effect.map((state) => Chunk.fromIterable(state.pullRequests)))
        )
        // Write: forkDaemon — returns immediately, refresh runs in background
        .handle("refresh", () =>
          prService.refresh.pipe(
            Effect.forkDaemon,
            Effect.map(() => "ok")
          )
        )
        // Search: FTS5 query against cached PRs
        .handle("search", ({ urlParams }) =>
          prService.searchPullRequests(urlParams.q).pipe(Effect.mapError((e) => new ApiError({ message: String(e) })))
        )
        // Write: create PR, map errors to ApiError
        .handle("create", ({ payload }) =>
          awsClient
            .createPullRequest({
              account: { profile: payload.account.profile, region: payload.account.region },
              repositoryName: payload.repositoryName,
              title: payload.title,
              ...(payload.description && { description: payload.description }),
              sourceReference: payload.sourceBranch,
              destinationReference: payload.destinationBranch
            })
            .pipe(Effect.mapError((e) => new ApiError({ message: e.message })))
        )
    )
    // + refreshSingle, comments, open
  })
)
```

### Incremental PR Streaming

Refresh updates `SubscriptionRef` per-PR, not in batch. Each PR from AWS streams
is inserted in sorted (creation-date) order. Clients polling `/api/prs/list` during
an active refresh see PRs appear incrementally -- each GET returns the current
growing snapshot.

## SSE Pattern: handleRaw + Combined Change Streams

### Implementation

```typescript
// events-live.ts — Schema-encoded SSE from merged PR + notification change streams

// 1. Define wire-format Schema
const SsePayload = Schema.Struct({
  pullRequests: Schema.Array(PullRequest),
  accounts: Schema.Array(AccountState),
  status: AppStatus,
  statusDetail: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  lastUpdated: Schema.optional(Schema.DateFromSelf),
  currentUser: Schema.optional(Schema.String),
  notifications: Schema.Array(NotificationItemResponse),
  unreadNotificationCount: Schema.Number
})

const encode = Schema.encode(SsePayload)  // Effect-based encode (not Sync)

// 2. Merge PR + notification streams, debounce, cache unread count
export const EventsLive = HttpApiBuilder.group(CodeCommitApi, "events", (handlers) =>
  Effect.gen(function*() {
    const prService = yield* PRService.PRService
    const notificationsService = yield* NotificationsService.NotificationsService

    const prChanges = prService.state.changes.pipe(Stream.map(() => "pr" as const))
    const notifChanges = notificationsService.state.changes.pipe(Stream.map(() => "notif" as const))
    const combined = Stream.merge(prChanges, notifChanges)

    // Cache unread count — only re-query DB on notification changes
    const initialCount = yield* prService.getUnreadNotificationCount().pipe(Effect.catchAll(() => Effect.succeed(0)))
    const lastUnreadRef = yield* Ref.make(initialCount)

    const stateStream = combined.pipe(
      Stream.debounce(Duration.millis(200)),
      Stream.mapEffect((trigger) =>
        Effect.all({
          prState: SubscriptionRef.get(prService.state),
          notifState: SubscriptionRef.get(notificationsService.state),
          unreadCount: trigger === "notif"
            ? prService.getUnreadNotificationCount().pipe(
              Effect.tap((c) => Ref.set(lastUnreadRef, c)),
              Effect.catchAll(() => Ref.get(lastUnreadRef)))
            : Ref.get(lastUnreadRef)
        })
      ),
      Stream.mapEffect(({ prState, notifState, unreadCount }) =>
        encode({ ...prState, notifications: notifState.items.map(...), unreadNotificationCount: unreadCount }).pipe(
          Effect.map((payload) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)),
          Effect.catchAll((e) =>
            Effect.logWarning("SSE encode failed", e).pipe(
              Effect.map(() => encoder.encode(":\n\n"))
            )
          )
        )
      )
    )

    return handlers.handleRaw("stream", () =>
      Effect.succeed(HttpServerResponse.stream(
        Stream.merge(stateStream, keepalive),
        { headers: { "content-type": "text/event-stream", ... } }
      )))
  }))
```

### Key Design Decisions

| Decision                                   | Rationale                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `handleRaw` over `handle`                  | Bypasses schema response encoding — returns raw `HttpServerResponse` with SSE headers |
| `SubscriptionRef.changes` over PubSub      | Already gives reactive stream per-subscriber; PubSub adds unnecessary indirection     |
| `Schema.encode(SsePayload)` (Effect-based) | Validates & transforms state (branded types → strings, etc.) at the Schema boundary   |
| `HttpServerResponse.stream(body, options)` | Returns streaming response; headers set via `options` (not chainable after)           |

### Why SubscriptionRef.changes (Not PubSub)

| SubscriptionRef.changes                                   | PubSub                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| Built-in — `prService.state` is already a SubscriptionRef | Requires extra wiring (fork daemon, publish loop)                         |
| Emits current value + all subsequent updates              | Must explicitly publish; misses state between subscribe and first publish |
| One stream per subscriber, automatic backpressure         | Fan-out to all subscribers, unbounded by default                          |
| Sufficient for full-state SSE                             | Better for typed event deltas (if needed later)                           |

### Why Schema Over Raw JSON.stringify

| Raw JSON.stringify                                             | Schema.encode                                       |
| -------------------------------------------------------------- | --------------------------------------------------- |
| No validation — silent data corruption                         | Schema validates structure at encode boundary       |
| Branded types serialize as plain strings (works, but implicit) | Explicit Schema handles branded → string conversion |
| Date handling depends on JSON.stringify behavior               | Schema controls Date serialization explicitly       |
| Changes to AppState may silently break SSE wire format         | Schema mismatch = compile-time or runtime error     |

## Error Propagation Pattern

### Service Errors → HTTP Responses

```typescript
// Handler: map to HTTP error
.handle("create", ({ payload }) =>
  awsClient.createPullRequest({ ... }).pipe(
    Effect.mapError((e) => new ApiError({ message: e.message }))
  ))
```

`ApiError` is declared in Api.ts via `HttpApiEndpoint.addError` — makes errors part of the API contract.

## Gotchas

1. **SubscriptionRef.get vs .changes** — `get` is a one-shot snapshot. `.changes` is a Stream that emits on every update. Use `get` for HTTP handlers, `.changes` for SSE.
2. **handleRaw vs handle** — `handleRaw` returns `Effect<HttpServerResponse | Success<Endpoint>>`. Use for SSE, file downloads, or any response needing custom headers/streaming.
3. **HttpServerResponse.stream headers** — Headers must be set in the `options` object (second arg). Cannot chain `setHeader()` after calling `stream()`.
4. **SSE keep-alive** — 30s heartbeat via `Stream.merge(stateStream, keepalive)` prevents browser timeout.
5. **Chunk return types** — Some handlers return `Chunk<T>` instead of `Array<T>`. HttpApi serializes both, but be consistent.

## Further Reading

- [SubscriptionRef](https://effect.website/docs/state-management/subscription-ref/)
- [HttpApi](https://effect.website/docs/platform/http-api/)
- [HttpApiBuilder](https://effect.website/docs/platform/http-api-builder/)
