# Effect Explainer: System Architecture

How the three codecommit packages work together — data flow, layer composition, shared services.

## Package Dependency Graph

```
┌──────────────────────┐
│   codecommit (TUI)   │  Ink/React terminal UI
│   bin.ts, atoms/*    │
└──────────┬───────────┘
           │ imports
           ▼
┌──────────────────────┐     ┌──────────────────────┐
│  codecommit-core     │◄────│  codecommit-web       │
│  Services + Domain   │     │  HttpApi + Vite SPA   │
└──────────────────────┘     └──────────────────────┘
```

`codecommit-core` is the shared kernel. Both `codecommit` (TUI) and `codecommit-web` depend on it but not on each other.

## Data Flow: From AWS to Pixel

### TUI Path

```
AWS CodeCommit API
        │
        ▼
┌─────────────────┐
│  AwsClient      │  HTTP calls via distilled-aws, retries throttle errors
│  (core)         │  Returns Stream<PullRequest> or Effect<T, AwsClientError>
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  PRService      │  Aggregates PRs from all accounts, manages AppState
│  (core)         │  SubscriptionRef<AppState> — reactive state container
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  runtimeAtom    │  Bridges Effect services → React atoms
│  (TUI)          │  Atom.runtime(AppLayer) creates managed Effect runtime
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  appStateAtom   │  runtimeAtom.subscribable(prService.state)
│  (TUI)          │  SubscriptionRef changes → atom updates → React re-renders
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  MainList       │  React component reads atom, renders PR list
│  (TUI)          │  useAtom(appStateAtom) → Result.Result<AppState>
└─────────────────┘
```

### Web Path

```
AWS CodeCommit API
        │
        ▼
┌─────────────────┐
│  AwsClient      │  Same service, same Layer
│  (core)         │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  PRService      │  Same SubscriptionRef<AppState>
│  (core)         │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  HttpApi        │  Typed endpoints: GET /api/prs, POST /api/prs, etc.
│  (web server)   │  Handlers read SubscriptionRef.get(prService.state)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Vite SPA       │  fetch("/api/prs") → React components
│  (web client)   │
└─────────────────┘
```

## Layer Composition: Same Services, Different Runtimes

Both TUI and web compose the same core services but with different platform layers.

### TUI Layer Stack

```
Atom.runtime(AppLayer)
  │
  ├── PRService.PRServiceLive
  │     ├── AwsClient.AwsClientLive
  │     │     ├── FetchHttpClient.layer    ← HTTP implementation
  │     │     └── AwsClientConfig.Default  ← timeouts/retry config
  │     ├── ConfigService.ConfigServiceLive
  │     │     └── BunContext.layer         ← FileSystem for config file
  │     └── NotificationsService.NotificationsServiceLive
  │
  ├── AwsClient.AwsClientLive             ← also exposed directly for atoms
  └── BunContext.layer                     ← CommandExecutor for shell commands
```

### Web Layer Stack

```
HttpLayerRouter.serve(AllRoutes)
  │
  ├── HandlersLive (PrsLive, ConfigLive, AccountsLive, EventsLive)
  │     ├── PRService.PRServiceLive        ← same as TUI
  │     ├── AwsClient.AwsClientLive        ← for direct API calls (createPR)
  │     └── ConfigService.ConfigServiceLive
  │
  ├── BunHttpServer.layer({ port })        ← HTTP server
  └── BunContext.layer                     ← platform services
```

Key insight: **Effect's Layer memoization** ensures each service is created once, even when referenced from multiple places. Both PRService and PrsLive handler access the same AwsClient instance.

## Service Boundaries

```
┌─────────────────────────────────────────────────┐
│                   codecommit-core                │
│                                                  │
│  Domain.ts        Branded types, Schema.Class    │
│  Errors.ts        TaggedError hierarchy          │
│  AwsClientConfig  Timeout/retry configuration    │
│  AwsClient/       AWS API calls (1 file/method)  │
│  ConfigService/   ~/.codecommit config file      │
│  PRService/       State aggregation + refresh    │
│    methods: state, refresh, toggleAccount,       │
│    setAllAccounts, clearNotifications,           │
│    addNotification                               │
│  NotificationsService  In-app notifications      │
│  DateUtils.ts     formatDate/DateTime/Relative   │
│                                                  │
│  Error flow:                                     │
│  AWS API → AwsApiError ─┐                        │
│  Credentials → AwsCredentialError ─┤  AwsClientError  │
│  Throttle → AwsThrottleError ─┘   (union)        │
│                                                  │
│  All methods retry throttle errors internally    │
│  via throttleRetry (exponential backoff + jitter).│
│  Errors that reach consumers = exhausted retries │
└─────────────────────────────────────────────────┘

┌──────────────────────────────┐  ┌──────────────────────────────┐
│       codecommit (TUI)       │  │      codecommit-web          │
│                              │  │                              │
│  atoms/runtime.ts            │  │  server/Server.ts            │
│    Atom.runtime(AppLayer)    │  │    HttpLayerRouter + CORS    │
│                              │  │                              │
│  atoms/app.ts                │  │  server/Api.ts               │
│    subscribable → read state │  │    Typed endpoint schemas    │
│    fn → write actions        │  │    ApiError TaggedError      │
│                              │  │                              │
│  atoms/actions.ts            │  │  server/handlers/*-live.ts   │
│    Effect.fnUntraced         │  │    HttpApiBuilder.handle     │
│    exhaustive catchTag       │  │    mapError → ApiError       │
│    withSpan for tracing      │  │                              │
│                              │  │  client/                     │
│  components/                 │  │    Vite SPA (React)          │
│    Ink React components      │  │    fetch-based API client    │
└──────────────────────────────┘  └──────────────────────────────┘
```

## Error Handling Strategy

```
                    AwsClient method
                         │
                    ┌────▼────┐
                    │ Retry   │  throttleRetry: exponential backoff + jitter
                    │ (core)  │  up to maxRetries (default 10)
                    └────┬────┘
                         │ exhausted? → AwsThrottleError
                         │ non-retryable? → AwsApiError / AwsCredentialError
                         ▼
              ┌──────────────────────┐
              │ Consumer handles     │
              └──────┬───────┬───────┘
                     │       │
            ┌────────▼──┐  ┌─▼────────────┐
            │ TUI atoms │  │ Web handlers  │
            │           │  │              │
            │ tapError  │  │ mapError     │
            │ → notify  │  │ → ApiError   │
            │ catchTag  │  │ (HTTP 500)   │
            │ → fallback│  │              │
            └───────────┘  └──────────────┘
```

- **TUI**: Shows notification, returns fallback (`""`, `[]`) so UI doesn't crash
- **Web**: Maps to `ApiError` TaggedError, HttpApi returns it as structured JSON error

### Retry Defaults (AwsClientConfig)

| Setting             | Default     |
| ------------------- | ----------- |
| `maxRetries`        | 10          |
| `retryBaseDelay`    | 2 seconds   |
| `maxRetryDelay`     | 60 seconds  |
| `credentialTimeout` | 5 seconds   |
| `operationTimeout`  | 30 seconds  |
| `streamTimeout`     | 60 seconds  |
| `refreshTimeout`    | 120 seconds |

### Throttle Detection

`isThrottlingError` checks error string (lowercased) for: `"throttl"`, `"rate exceed"`, `"too many requests"`, `"requestlimitexceeded"`, `"slowdown"`, `"toomanyrequestsexception"`.

### Concurrency Values

| Location             | Operator                            | Concurrency |
| -------------------- | ----------------------------------- | ----------- |
| `refresh.ts`         | `Stream.mergeAll(streams, ...)`     | 2           |
| `getPullRequests.ts` | `Stream.flatMap(repo => listPRIds)` | 2           |
| `getPullRequests.ts` | `Stream.mapEffect(fetchPRDetails)`  | 3           |

## Shared Patterns Across Packages

| Pattern                    | Core                  | TUI                       | Web                               |
| -------------------------- | --------------------- | ------------------------- | --------------------------------- |
| `Context.Tag`              | All services          | —                         | —                                 |
| `Layer.effect`             | Implementations       | `Atom.runtime`            | `makeServer`                      |
| `Effect.fn` / `fnUntraced` | Service methods       | Atom actions              | —                                 |
| `Effect.withSpan`          | All operations        | All atoms                 | —                                 |
| `Schema.Class`             | Domain models         | —                         | API schemas                       |
| `Schema.TaggedError`       | Error hierarchy       | —                         | `ApiError`                        |
| `SubscriptionRef`          | PRService state       | `subscribable` atoms      | `SubscriptionRef.get` in handlers |
| `Effect.catchTag`          | —                     | Exhaustive error handling | `mapError` to ApiError            |
| `throttleRetry`            | All AwsClient methods | —                         | —                                 |

## Incremental Streaming

`refresh.ts` streams PRs **per-PR** into `SubscriptionRef`, not batch-per-account. Each PR emitted by `getPullRequests` is inserted (sorted by `creationDate` desc) into `AppState.pullRequests` via `SubscriptionRef.update`. The UI re-renders incrementally as PRs arrive.

```typescript
// refresh.ts — per-PR streaming into SubscriptionRef
yield *
  Stream.mergeAll(streams, { concurrency: 2 }).pipe(
    Stream.runForEach(({ pr }) =>
      SubscriptionRef.update(deps.state, (s) => {
        // binary-insert by creationDate descending
        const insertIdx = prs.findIndex((p) => p.creationDate < pr.creationDate)
        return { ...s, pullRequests: [...before, pr, ...after] }
      })
    )
  )
```

## Layer.mergeAll + Effect.provide Scoping

Each AwsClient method acquires credentials then scopes `Region`, `Credentials`, `HttpClient` for the distilled-aws call via `Effect.provide(effect, Layer.mergeAll(...))`. Replaced the old `withAwsContext` helper.

```typescript
// Per-method pattern in each AwsClient file
const credentials = yield * acquireCredentials(profile, region)

return (
  yield *
  Effect.provide(
    callAwsOperation(params),
    Layer.mergeAll(
      Layer.succeed(HttpClient.HttpClient, httpClient),
      Layer.succeed(Region.Region, params.account.region),
      Layer.succeed(Credentials.Credentials, credentials)
    )
  )
)
```

At the `AwsClientLive` layer level, `provide`/`provideStream` helpers strip `AwsClientConfig` + `HttpClient` from each method's requirements:

```typescript
// AwsClient/index.ts
const provide = <A, E>(effect: Effect<A, E, AwsClientConfig | HttpClient>) =>
  effect.pipe(Effect.provideService(AwsClientConfig, config), Effect.provideService(HttpClient.HttpClient, httpClient))
```

## DateUtils — Match.value Pattern

`DateUtils.ts` uses `Match.value` for range-based formatting:

```typescript
export const formatRelativeTime = (date: Date, now: Date): string => {
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000)
  return Match.value(seconds).pipe(
    Match.when(
      (s) => s < 60,
      (s) => `Updated ${s}s ago`
    ),
    Match.when(
      (s) => s < 3600,
      (s) => `Updated ${Math.floor(s / 60)}m ago`
    ),
    Match.when(
      (s) => s < 86400,
      (s) => `Updated ${Math.floor(s / 3600)}h ago`
    ),
    Match.orElse(() => `Updated on ${formatDate(date)}`)
  )
}
```

`Match.value` replaces if/else chains with exhaustive, pipe-friendly pattern matching.

## Testing Story

```
Unit tests (core)        → mock FileSystem, test ConfigService parsing
                         → mock HttpClient, test AwsClient error handling
                         → test Domain Schema validation

Integration tests (TUI)  → mock PRService, test atom state transitions
                         → verify keyboard nav, filter logic

Integration tests (web)  → HttpApi test client against handlers
                         → mock PRService.state, verify JSON responses
```

Each layer of the stack can be tested independently because Effect services are swappable via Layer composition. Replace `AwsClient.AwsClientLive` with a test layer that returns canned data — zero network calls.
