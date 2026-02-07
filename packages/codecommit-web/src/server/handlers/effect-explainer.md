# Effect Explainer: Server Handlers

Handler patterns — Schema-encoded SSE via SubscriptionRef, typed error propagation to HTTP responses.

## Handler Map

| File               | Endpoint        | Pattern                                                                        |
| ------------------ | --------------- | ------------------------------------------------------------------------------ |
| `prs-live.ts`      | `/api/prs/*`    | Read SubscriptionRef, trigger refresh, create PR                               |
| `config-live.ts`   | `/api/config`   | Load config, merge with runtime state                                          |
| `accounts-live.ts` | `/api/accounts` | Filter enabled accounts from state                                             |
| `events-live.ts`   | `/api/events/`  | SSE — `handleRaw` + `HttpServerResponse.stream` from `SubscriptionRef.changes` |

## Read-Only Handlers: SubscriptionRef Snapshot

Most handlers follow the same pattern — get a snapshot of current state:

```typescript
// accounts-live.ts
HttpApiBuilder.handle("list", () =>
  Effect.gen(function* () {
    const prService = yield* PRService
    const state = yield* SubscriptionRef.get(prService.state)
    return Chunk.fromIterable(state.accounts.filter((a) => a.enabled).map((a) => ({ id: a.profile, region: a.region })))
  })
)
```

`SubscriptionRef.get` returns the current value without subscribing to changes.
For one-shot HTTP responses, this is correct — no need for a persistent subscription.

## Config Handler: Multi-Service Composition

```typescript
// config-live.ts — combines two services
HttpApiBuilder.handle("get", () =>
  Effect.gen(function* () {
    const configService = yield* ConfigService
    const prService = yield* PRService

    const config = yield* configService.load.pipe(
      Effect.catchAll(() => Effect.succeed({ accounts: [], autoDetect: true }))
    )

    const state = yield* SubscriptionRef.get(prService.state)

    return {
      accounts: config.accounts,
      autoDetect: config.autoDetect,
      currentUser: state.currentUser
    }
  })
)
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
    const httpClient = yield* HttpClient.HttpClient

    return (
      handlers
        // Read: snapshot of current PRs (returns Chunk)
        .handle("list", () =>
          SubscriptionRef.get(prService.state).pipe(Effect.map((state) => Chunk.fromIterable(state.pullRequests)))
        )
        // Write: trigger refresh, provide HttpClient for AWS calls
        .handle("refresh", () =>
          prService.refresh.pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.map(() => "ok")
          )
        )
        // Write: create PR, map errors to ApiError
        .handle("create", ({ payload }) =>
          awsClient
            .createPullRequest({
              account: { profile: payload.account.id, region: payload.account.region },
              repositoryName: payload.repositoryName,
              title: payload.title,
              ...(payload.description && { description: payload.description }),
              sourceReference: payload.sourceBranch,
              destinationReference: payload.destinationBranch
            })
            .pipe(Effect.mapError((e) => new ApiError({ message: e.message })))
        )
    )
  })
)
```

### Incremental PR Streaming

Refresh updates `SubscriptionRef` per-PR, not in batch. Each PR from AWS streams
is inserted in sorted (creation-date) order. Clients polling `/api/prs/list` during
an active refresh see PRs appear incrementally -- each GET returns the current
growing snapshot.

## SSE Pattern: handleRaw + SubscriptionRef.changes

### Implementation

```typescript
// events-live.ts — Schema-encoded SSE from SubscriptionRef.changes

// 1. Define wire-format Schema for the SSE payload
const SsePayload = Schema.Struct({
  pullRequests: Schema.Array(PullRequest),
  accounts: Schema.Array(AccountState),
  status: AppStatus,
  statusDetail: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  lastUpdated: Schema.optional(Schema.DateFromSelf),
  currentUser: Schema.optional(Schema.String)
})

const encode = Schema.encodeSync(SsePayload)

// 2. handleRaw bypasses schema response encoding — returns raw HttpServerResponse
export const EventsLive = HttpApiBuilder.group(CodeCommitApi, "events", (handlers) =>
  Effect.gen(function* () {
    const prService = yield* PRService.PRService

    return handlers.handleRaw("stream", () =>
      Effect.succeed(
        HttpServerResponse.stream(
          prService.state.changes.pipe(
            Stream.map((state) => {
              const payload = encode(state)
              return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
            })
          ),
          {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive"
            }
          }
        )
      )
    )
  })
)
```

### Key Design Decisions

| Decision                                   | Rationale                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `handleRaw` over `handle`                  | Bypasses schema response encoding — returns raw `HttpServerResponse` with SSE headers |
| `SubscriptionRef.changes` over PubSub      | Already gives reactive stream per-subscriber; PubSub adds unnecessary indirection     |
| `Schema.encodeSync(SsePayload)`            | Validates & transforms state (branded types → strings, etc.) at the Schema boundary   |
| `HttpServerResponse.stream(body, options)` | Returns streaming response; headers set via `options` (not chainable after)           |

### Why SubscriptionRef.changes (Not PubSub)

| SubscriptionRef.changes                                   | PubSub                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| Built-in — `prService.state` is already a SubscriptionRef | Requires extra wiring (fork daemon, publish loop)                         |
| Emits current value + all subsequent updates              | Must explicitly publish; misses state between subscribe and first publish |
| One stream per subscriber, automatic backpressure         | Fan-out to all subscribers, unbounded by default                          |
| Sufficient for full-state SSE                             | Better for typed event deltas (if needed later)                           |

### Why Schema Over Raw JSON.stringify

| Raw JSON.stringify                                             | Schema.encodeSync                                   |
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
4. **SSE keep-alive** — Browsers close SSE connections after ~45s of silence. Consider merging a heartbeat: `Stream.merge(Stream.repeatEffect(Effect.delay(Effect.succeed(":\n\n"), "30 seconds")))`.
5. **Chunk return types** — Some handlers return `Chunk<T>` instead of `Array<T>`. HttpApi serializes both, but be consistent.

## Further Reading

- [SubscriptionRef](https://effect.website/docs/state-management/subscription-ref/)
- [HttpApi](https://effect.website/docs/platform/http-api/)
- [HttpApiBuilder](https://effect.website/docs/platform/http-api-builder/)
