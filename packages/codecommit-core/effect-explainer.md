# Effect Explainer: codecommit-core

Service architecture overview — why Effect services beat DI frameworks.

## Dependency Graph

```
                    ┌─────────────────┐
                    │   PRService      │
                    │  (orchestrator)  │
                    └──┬──┬──┬──┬─────┘
                       │  │  │  │
          ┌────────────┘  │  │  └────────────┐
          │      ┌────────┘  └──────┐        │
          ▼      ▼                  ▼        ▼
  ┌────────────┐ ┌──────────────┐ ┌────────────────────┐
  │ AwsClient  │ │ConfigService │ │   CacheService     │
  │ (8 methods)│ │(load/save/   │ │   (SQLite repos)   │
  │            │ │ detect)      │ │                    │
  └──────┬─────┘ └──────┬───────┘ └────────┬───────────┘
         │              │                  │
         ▼              ▼                  ▼
  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
  │AwsClientConfig│ │  FileSystem  │ │  DatabaseLive    │
  │  (timeouts,  │ │  Path        │ │ (libsql/Turso +  │
  │   retries)   │ │  (platform)  │ │  migrations)     │
  └──────────────┘ └──────────────┘ └──────────────────┘

  ┌───────────────────────────────────────────────────┐
  │  CacheService Repos (Effect.Service auto-wired)   │
  │  PullRequestRepo │ CommentRepo │ NotificationRepo │
  │  SubscriptionRepo│ SyncMetadataRepo               │
  │  EventsHub (PubSub-based change notification)     │
  │                                                   │
  │  Each declares: dependencies: [DatabaseLive,      │
  │    EventsHub.Default] → auto-satisfied by layer   │
  └───────────────────────────────────────────────────┘
```

## Why Effect Services > DI Frameworks

### The Problem with Traditional DI

```typescript
// Spring/NestJS style: runtime errors, no compile-time guarantees
@Injectable()
class PRService {
  constructor(
    @Inject("AwsClient") private aws: AwsClient, // string token = runtime bomb
    @Inject("Config") private config: ConfigService
  ) {}
}
```

- Dependencies resolved at runtime — missing binding = crash in production
- Circular dependency detection: runtime only
- Testing: mock setup is ceremony-heavy

### Effect's Approach: Types ARE the DI Container

```typescript
// Effect style: compiler refuses to build if deps are missing
const refresh: Effect<void, RefreshError, PRService | AwsClient | ConfigService>
//                                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                                        R channel = compile-time dependency list
```

The `R` (Requirements) channel is a **type-level dependency graph**. The compiler:

1. Tracks every service needed
2. Refuses to compile if any Layer is missing
3. Automatically deduplicates shared dependencies

### Layer Composition = Dependency Wiring

```typescript
// Each Layer declares what it provides and what it needs
const AwsClientLive: Layer<AwsClient, never, AwsClientConfig | HttpClient>
const ConfigServiceLive: Layer<ConfigService, never, FileSystem | Path>

// Compose: compiler checks the math
const PRServiceLive: Layer<PRService, never, AwsClient | ConfigService | NotificationsService>
```

When you `Layer.provide`, Effect:

- Resolves the dependency graph at compile time
- Memoizes shared layers (ConfigService built once, shared by all consumers)
- Guarantees resource cleanup in reverse-acquisition order

## Service Pattern Used Here

Every service follows the same 3-part structure:

```
1. Context.Tag class      — the interface (what consumers see)
2. Layer.effect(Tag, ...)  — the implementation (how it works)
3. Split methods           — one file per method (AwsClient/, ConfigService/, PRService/)
```

### Why Split Methods Into Files?

```
AwsClient/
  index.ts              ← Tag + Layer (public API)
  internal.ts           ← shared helpers (auth, retry, error mapping)
  getPullRequests.ts    ← one method
  createPullRequest.ts  ← one method
  ...
```

- Each method file is ~30-50 lines — easy to review
- `internal.ts` holds shared concerns (auth, retry, error mapping)
- Methods are direct exports reading deps from context (no factory pattern)
- The Layer in `index.ts` captures `AwsClientConfig` + `HttpClient` and provides them to each method

### Extracted Sub-Helpers Pattern

Each method file extracts small, focused helpers above the main export:

```typescript
// getPullRequests.ts
const fetchPRDetails = (id, repoName) => ...    // single PR detail fetch
const toPullRequest = (account, rawData) => ...  // domain mapping
const fetchApprovalStatus = (...) => ...         // approval check
const fetchMergeStatus = (...) => ...            // merge conflict check

// getCommentsForPullRequest.ts
const fetchCommentPages = (pullRequestId, repo) => ...  // paginated stream
const toComment = (raw, location) => ...                // domain mapping
const toCommentLocation = (data) => ...                 // location mapping
const buildThreads = (comments) => ...                  // thread tree builder

// createPullRequest.ts
const callCreatePullRequest = (params) => ...    // raw API call
```

Keeps each function 5-15 lines. Main export just orchestrates them.

## Key Architectural Decisions

### withAwsContext Combinator (S1)

All AwsClient methods (except `getPullRequests` which returns a Stream) share the same boilerplate:
acquire credentials → build Layer → provide → retry → timeout → error map.

The `withAwsContext` combinator in `internal.ts` eliminates this duplication:

```typescript
// internal.ts — shared combinator
export const withAwsContext = <A, E>(
  operation: string,
  account: AccountParams,
  effect: Effect.Effect<A, E, HttpClient | Region | Credentials>,
  options?: { readonly timeout?: "stream" }
) =>
  Effect.gen(function* () {
    const config = yield* AwsClientConfig
    const httpClient = yield* HttpClient.HttpClient
    const credentials = yield* acquireCredentials(account.profile, account.region)
    const timeout = options?.timeout === "stream" ? config.streamTimeout : config.operationTimeout

    return yield* Effect.provide(
      effect,
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(Region.Region, account.region),
        Layer.succeed(Credentials.Credentials, credentials)
      )
    ).pipe(
      throttleRetry,
      Effect.timeout(timeout),
      Effect.catchTag("TimeoutException", (cause) =>
        Effect.fail(makeApiError(operation, account.profile, account.region, cause))
      )
    )
  })
```

Each method file becomes minimal — just the API call logic:

```typescript
// createPullRequest.ts — entire file is ~15 lines
export const createPullRequest = (params: CreatePullRequestParams) =>
  withAwsContext("createPullRequest", params.account, callCreatePullRequest(params))
```

The `options.timeout` parameter differentiates operations (`operationTimeout`) from streaming calls (`streamTimeout`). `getPullRequests.ts` doesn't use this combinator because it returns `Stream.Stream` which requires `Stream.provideService` instead of `Effect.provide`.

### Centralized Config via AwsClientConfig

All timeouts and retry params come from one `Context.Tag`:

- `credentialTimeout` — how long to wait for AWS credentials (default: "5 seconds")
- `operationTimeout` — single API call timeout (default: "30 seconds")
- `streamTimeout` — pagination/streaming timeout (default: "60 seconds")
- `refreshTimeout` — full refresh timeout (default: "120 seconds")
- `maxRetries` — max retry attempts (default: 10)
- `retryBaseDelay` — initial retry delay (default: "2 seconds")
- `maxRetryDelay` — retry delay cap (default: "60 seconds")

### throttleRetry: Pipe-Friendly Retry

```typescript
// internal.ts — reads schedule config from AwsClientConfig context
export const throttleRetry = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | AwsClientConfig> =>
  Effect.flatMap(AwsClientConfig, (config) =>
    effect.pipe(
      Effect.retry(makeThrottleSchedule(config).pipe(Schedule.whileInput((error: E) => isThrottlingError(error))))
    )
  )
```

- Pipe-friendly: `someEffect.pipe(throttleRetry)` or `throttleRetry(someEffect)`
- Adds `AwsClientConfig` to the `R` channel (auto-satisfied when Layer provides it)
- Schedule: exponential backoff (base 2s) with jitter, capped at 60s, max 10 retries
- Only retries throttling errors (`isThrottlingError` checks error strings)

### acquireCredentials: Profile + Region, Config from Context

```typescript
export const acquireCredentials = (profile: string, region: string) =>
  Effect.flatMap(AwsClientConfig, (config) =>
    Effect.tryPromise({
      try: () => fromNodeProviderChain(profile === "default" ? {} : { profile })(),
      catch: (cause) => new AwsCredentialError({ profile, region, cause })
    }).pipe(
      Effect.map(Credentials.fromAwsCredentialIdentity),
      Effect.timeout(config.credentialTimeout),
      Effect.catchTag("TimeoutException", (cause) => new AwsCredentialError({ profile, region, cause }))
    )
  )
```

Takes `(profile, region)`. Reads `credentialTimeout` from `AwsClientConfig` context.

### Typed Error Hierarchy

```
CodeCommitError (union)
├── AwsCredentialError    — credential acquisition failed
├── AwsThrottleError      — API throttling / rate limit hit
├── AwsApiError           — AWS API call failed
├── ConfigError           — config file I/O
├── ConfigParseError      — config JSON invalid
├── ProfileDetectionError — AWS config parsing
├── RefreshError          — PR refresh orchestration
└── CacheError            — SQLite cache operation failure (SQL, parse, connection)
```

Every error is a `Schema.TaggedError` — serializable, pattern-matchable, no `unknown`.

Error cause fields use `Schema.Defect` (not `Schema.Unknown`) — properly handles non-serializable error objects.

```typescript
// AwsClientError union (used for AwsClient method signatures)
type AwsClientError = AwsCredentialError | AwsThrottleError | AwsApiError
```

### Concurrency Tuning

`getPullRequests` uses tiered concurrency:

- `concurrency: 2` for repo listing → PR ID streams (moderate parallelism per account)
- `concurrency: 3` for fetching PR details (approval + merge status per PR)

`PRService/refresh` uses `Stream.mergeAll(streams, { concurrency: 2 })` to process account/region streams in parallel.

### Incremental Streaming (PRService/refresh)

PRs stream incrementally to the UI via `SubscriptionRef`:

```typescript
yield *
  Stream.mergeAll(streams, { concurrency: 2 }).pipe(
    Stream.runForEach(({ label, pr }) =>
      SubscriptionRef.update(state, (s) => {
        // insert PR sorted by creationDate — UI updates per-PR
        const prs = s.pullRequests.filter((p) => !(p.id === pr.id && p.account.profile === pr.account.profile))
        const insertIdx = prs.findIndex((p) => p.creationDate.getTime() < pr.creationDate.getTime())
        const newPrs = insertIdx === -1 ? [...prs, pr] : [...prs.slice(0, insertIdx), pr, ...prs.slice(insertIdx)]
        return { ...s, pullRequests: newPrs, statusDetail: `${label} #${pr.id}` }
      })
    )
  )
```

Each PR updates `SubscriptionRef` immediately as it arrives. No batching — the TUI sees PRs appear one-by-one in sorted order.

### DateUtils Module

`DateUtils.ts` uses `Match.value` from Effect for relative time formatting:

```typescript
import { Match } from "effect"

export const formatRelativeTime = (date: Date, now: Date): string => {
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000))

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

`Match.value` = exhaustive pattern matching on values (not union types). Replaces if/else chains with declarative pipelines.

## CacheService Architecture

Local SQLite cache powered by `@effect/sql-libsql` (Turso/libsql).

### Database Layer

```typescript
// Database.ts
export const LibsqlLive = Layer.unwrapEffect(
  Effect.map(dbUrl, (url) =>
    LibsqlClient.layer({
      url,
      transformResultNames: (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    })
  )
)

export const MigrationsLive = LibsqlMigrator.layer({
  loader: LibsqlMigrator.fromRecord({
    "0001_initial": migration0001,
    "0002_indexes": migration0002
    // ...
  })
})

export const DatabaseLive = MigrationsLive.pipe(Layer.provideMerge(LibsqlLive))
```

`transformResultNames` converts SQL `snake_case` columns to JS `camelCase` automatically — no manual mapping in queries. Migrations use `LibsqlMigrator.fromRecord` for bundled (non-filesystem) loaders.

### Repo Pattern (Effect.Service)

Each repo uses `Effect.Service` with auto-wired dependencies:

```typescript
export class PullRequestRepo extends Effect.Service<PullRequestRepo>()("PullRequestRepo", {
  dependencies: [DatabaseLive, EventsHub.Default],  // ← auto-provided
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const hub = yield* EventsHub

    const upsert = (input: UpsertInput) =>
      upsert_(input).pipe(
        Effect.tap(() => hub.publish(RepoChange.PullRequests())),
        cacheError("upsert")
      )
    // ...
    return { findAll, findByAccountAndId, upsert, search, ... }
  })
}) {}
```

`dependencies` declares which layers are auto-provided when using `PullRequestRepo.Default` — no manual wiring. Each mutation publishes to `EventsHub` for real-time change propagation.

### EventsHub (Batched PubSub)

```typescript
export class EventsHub extends Effect.Service<EventsHub>()("EventsHub", {
  effect: Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<RepoChange>()
    // ...
    return { publish, batch, subscribe }
  })
}) {}
```

`batch(effect)` accumulates change tags during the effect, then emits deduplicated notifications when done. Prevents notification storms during refresh (dozens of upserts → one `PullRequests` event).

`RepoChange` uses `Data.TaggedEnum` for type-safe event variants:

```typescript
export type RepoChange = Data.TaggedEnum<{
  PullRequests: {}
  Notifications: {}
  Subscriptions: {}
  Comments: {}
  Config: {}
  AppState: {}
  SystemNotifications: {}
}>
```

### CacheError (C2)

All cache operations wrap errors in a typed `CacheError`:

```typescript
export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
  operation: Schema.String,
  cause: Schema.Defect
}) {}
```

Per-repo error wrapper pattern:

```typescript
const cacheError =
  (op: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) => new CacheError({ operation: `PullRequestRepo.${op}`, cause })),
      Effect.withSpan(`PullRequestRepo.${op}`, { captureStackTrace: false })
    )
```

Every repo method pipes through `cacheError("methodName")` — typed errors + automatic OpenTelemetry spans.

## Effect.fn for Traced Functions (S5)

PRService methods use `Effect.fn` for automatic OpenTelemetry span tracing:

```typescript
export const makeRefresh = Effect.fn("PRService.refresh")(
  function*(state: PRState) { /* body */ },
  (effect, state) => effect.pipe(    // ← pipeables receive (effect, ...originalArgs)
    Effect.timeout("120 seconds"),
    Effect.catchAllCause((cause) => {
      const squashed = Cause.squash(cause)
      return SubscriptionRef.update(state, (s) => ({ ...s, status: "error", error: ... }))
    })
  )
)
```

`Effect.fn` wraps a generator into a traced function. The first argument is the span name. Pipeables receive `(effect, ...originalArgs)` — enabling error handlers that reference original args (like `state`).

## Testing Story

```typescript
// Provide mock layers — compiler ensures completeness
const TestLayer = Layer.succeed(AwsClient, {
  getPullRequests: () => Stream.empty
  // ... compiler forces you to implement all methods
})

Effect.provide(program, TestLayer) // type-safe, no runtime surprises
```

## Further Reading

- [Effect Services](https://effect.website/docs/requirements-management/services/)
- [Layer](https://effect.website/docs/requirements-management/layers/)
- [Schema.TaggedError](https://effect.website/docs/error-management/expected-errors/)
