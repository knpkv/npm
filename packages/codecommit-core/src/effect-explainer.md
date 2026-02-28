# Effect Explainer: codecommit-core/src

Module-by-module guide — branded types, Schema.Class, tagged errors as values.

## Module Map

```
src/
├── Domain.ts              <- Schema.Class models + branded IDs
├── Errors.ts              <- Schema.TaggedError hierarchy
├── AwsClientConfig.ts     <- Context.Tag for timeout/retry config
├── DateUtils.ts           <- Date formatting + Match.value pattern matching
├── AwsClient/             <- AWS API service (1 file per method)
├── ConfigService/         <- Config loading/saving (split methods)
├── PRService/             <- PR orchestration (split methods)
│   ├── internal.ts        <- Shared helpers (prToUpsertInput, countAllComments)
│   ├── refresh.ts         <- Full refresh (Ref-managed state, streaming)
│   ├── refreshSinglePR.ts <- Single PR refresh
│   ├── setAllAccounts.ts  <- Enable/disable all accounts
│   └── toggleAccount.ts   <- Toggle single account
├── CacheService/          <- SQLite cache layer (libsql)
│   ├── Database.ts        <- DatabaseLive layer (connection + migrations)
│   ├── diff.ts            <- PR/comment diff → notifications
│   ├── repos/             <- SqlSchema-based repos (Effect.Service pattern)
│   └── migrations/        <- SQL schema migrations
├── NotificationsService.ts <- Notification state management
└── index.ts               <- Namespace re-exports
```

## Domain.ts — Schema.Class + Branded Types

### Why Schema.Class Over Plain Interfaces?

```typescript
// Plain interface: no runtime validation, no serialization
interface PullRequest {
  id: string
  title: string
}

// Schema.Class: validates at boundaries, serializes for free
class PullRequest extends Schema.Class<PullRequest>("PullRequest")({
  id: Schema.String,
  title: Schema.String,
  creationDate: Schema.DateFromSelf
  // ...
}) {
  get consoleUrl() {
    return `https://.../${this.id}`
  }
}
```

Schema.Class gives you:

1. **Runtime validation** — `Schema.decodeSync(PullRequest)(rawData)` throws on bad input
2. **Serialization** — `Schema.encodeSync` for JSON, SSE, persistence
3. **Custom getters** — computed properties (like `consoleUrl`)
4. **TypeScript type** — `PullRequest` is both a class and a type

### Branded Types

```typescript
// Without brands: any string fits anywhere — silent bugs
getComments({ pullRequestId: repositoryName }) // compiles but wrong!

// With brands: compiler catches misuse
type PullRequestId = string & Brand.Brand<"PullRequestId">
type RepositoryName = string & Brand.Brand<"RepositoryName">
getComments({ pullRequestId: repoName }) // TS error!
```

### Schema.DateFromSelf

```typescript
// Schema.Date: expects ISO string input, produces Date
// Schema.DateFromSelf: expects Date input, keeps Date
creationDate: Schema.DateFromSelf
```

Use `DateFromSelf` when the source already has `Date` objects (like AWS SDK responses).

## Errors.ts — Tagged Error Hierarchy

### Why Schema.TaggedError?

```typescript
// Basic Error: no structure, no pattern matching
throw new Error("something failed")

// Schema.TaggedError: structured, serializable, matchable
class AwsApiError extends Schema.TaggedError<AwsApiError>()("AwsApiError", {
  operation: Schema.String,
  profile: Schema.String,
  region: Schema.String,
  cause: Schema.Defect // preserves arbitrary cause (not Schema.Unknown)
}) {}
```

**Schema.Defect vs Schema.Unknown**: `Schema.Defect` preserves error identity through serialization roundtrips. All cause fields in this codebase use `Schema.Defect`:

```typescript
class AwsCredentialError extends Schema.TaggedError<AwsCredentialError>()("AwsCredentialError", {
  profile: Schema.String,
  region: Schema.String,
  cause: Schema.Defect
}) {}
// Same for AwsThrottleError, AwsApiError, ConfigError, ConfigParseError, etc.
```

Pattern matching with `Effect.catchTag`:

```typescript
effect.pipe(
  Effect.catchTag("AwsApiError", (e) => /* handle API error */),
  Effect.catchTag("AwsCredentialError", (e) => /* handle cred error */),
  // compiler warns if you miss a tag
)
```

### Error Union for Exhaustive Handling

```typescript
type AwsClientError = AwsCredentialError | AwsThrottleError | AwsApiError
// Use in method signatures -> consumers know exactly what can fail
```

## DateUtils.ts — Match.value Pattern Matching

Uses `Match.value` for declarative range-based dispatch:

```typescript
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

`Match.value` + `Match.when` replaces nested if/else with composable predicates.

## AwsClient/ — Direct Exports + Layer.mergeAll

### Architecture

```
internal.ts                      index.ts (Layer)
┌──────────────────────┐        ┌──────────────────────────────────┐
│ acquireCredentials   │        │ AwsClientLive = Layer.effect(    │
│ throttleRetry        │<───────│   yield* AwsClientConfig         │
│ makeApiError         │        │   yield* HttpClient              │
│ normalizeAuthor      │        │   return {                       │
│ AccountParams        │        │     getPullRequests,             │
│ CreatePRParams...    │        │     createPullRequest,           │
└──────────────────────┘        │     getCommentsForPullRequest... │
                                │   }                              │
                                │ )                                │
                                └──────────────────────────────────┘
```

Each method file exports a **direct function** (not a factory). No `makeXxx(config, http)` pattern. Methods read `AwsClientConfig` and `HttpClient` from Effect context directly:

```typescript
// createPullRequest.ts — direct export, not a factory
export const createPullRequest = (params: CreatePullRequestParams) =>
  Effect.gen(function* () {
    const config = yield* AwsClientConfig
    const httpClient = yield* HttpClient.HttpClient
    const credentials = yield* acquireCredentials(params.account.profile, params.account.region)
    // ...
  })
```

The `AwsClientLive` layer captures config + httpClient once, then provides them to each method via `provide`/`provideStream` helpers.

### acquireCredentials — Reads Config from Context

```typescript
// Signature: (profile, region) -> Effect<Credentials, AwsCredentialError, AwsClientConfig>
// Reads timeout from AwsClientConfig context — no config param needed
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

### throttleRetry — Pipe-Friendly, Context-Aware

```typescript
// Pipe-friendly: reads schedule config from AwsClientConfig context
export const throttleRetry = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | AwsClientConfig> =>
  Effect.flatMap(AwsClientConfig, (config) =>
    effect.pipe(
      Effect.retry(makeThrottleSchedule(config).pipe(Schedule.whileInput((error: E) => isThrottlingError(error))))
    )
  )

// Usage — just pipe it:
callCreatePullRequest(params).pipe(throttleRetry)
```

### Effect.provide + Layer.mergeAll — The Key Pattern

Instead of `provideService` per dependency, methods use `Effect.provide` with `Layer.mergeAll` to supply all AWS context at once:

```typescript
// createPullRequest.ts — actual code
export const createPullRequest = (params: CreatePullRequestParams) =>
  Effect.gen(function* () {
    const config = yield* AwsClientConfig
    const httpClient = yield* HttpClient.HttpClient
    const credentials = yield* acquireCredentials(params.account.profile, params.account.region)

    return yield* Effect.provide(
      callCreatePullRequest(params), // inner effect needs Region + Credentials + HttpClient
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(Region.Region, params.account.region),
        Layer.succeed(Credentials.Credentials, credentials)
      )
    ).pipe(
      throttleRetry,
      Effect.timeout(config.operationTimeout),
      Effect.catchTag("TimeoutException", (cause) =>
        Effect.fail(makeApiError("createPullRequest", params.account.profile, params.account.region, cause))
      )
    )
  })
```

Why `Layer.mergeAll` over chained `provideService`? Single `provide` call, reads cleaner, and the distilled-aws library expects services via Layer context.

### Extracted Sub-Helpers Pattern

Each method file extracts small focused helpers to keep the main export clean:

**createPullRequest.ts:**

- `callCreatePullRequest(params)` — raw AWS call + error mapping

**getPullRequests.ts:**

- `fetchPRDetails(id, repoName)` — fetch approval + merge status for one PR
- `fetchApprovalStatus(pullRequestId, revisionId)` — throttled approval check
- `fetchMergeStatus(repoName, target)` — throttled merge conflict check
- `toPullRequest(account, rawData)` — raw AWS data to domain `PullRequest`
- `listAllRepositories()` — paginated repo stream
- `listPullRequestIds(repoName, status)` — paginated PR ID stream

**getCommentsForPullRequest.ts:**

- `fetchCommentPages(pullRequestId, repositoryName)` — paginated comment stream
- `toComment(rawComment, location)` — raw comment to domain `PRComment`
- `toCommentLocation(data)` — raw location data to `PRCommentLocation`
- `buildThreads(comments)` — flat comments to nested `CommentThread` tree

### Stream.paginateEffect — AWS Pagination

```typescript
// Instead of recursive fetchPage(), declarative pagination:
Stream.paginateEffect(
  undefined as string | undefined, // initial token
  (nextToken) =>
    api
      .list({ ...params, nextToken })
      .pipe(Effect.map((resp) => [resp.items, resp.nextToken ? Option.some(resp.nextToken) : Option.none()]))
)
```

### Concurrency Model in getPullRequests

```typescript
const stream = listAllRepositories().pipe(
  // Fan out: 2 repos fetching PR IDs concurrently
  Stream.flatMap((repoName) => listPullRequestIds(repoName, status), { concurrency: 2 }),
  // Fan out: 3 PR detail fetches concurrently (approval + merge status)
  Stream.mapEffect(
    ({ id, repoName }) => throttleRetry(fetchPRDetails(id, repoName)),
    { concurrency: 3 }
  ),
  Stream.map((pr) => toPullRequest(account, pr)),
  Stream.mapError((cause) => makeApiError(...))
)
```

Two-level concurrency: repos fan out at 2, PR details at 3. Keeps AWS throttling manageable.

## ConfigService/ — Schema Everywhere

### parseAwsConfig — Schema Validation for INI Parsing

```typescript
// Parse AWS config INI -> validate each section through Schema
const decoded = Schema.decodeUnknownEither(DetectedProfile)(section)
if (Either.isRight(decoded)) result.push(decoded.right)
// Invalid sections silently filtered — no crashes on malformed config
```

### Schema.parseJson — Replace JSON.parse

```typescript
const config = Schema.decodeUnknown(Schema.parseJson(TuiConfig))(content)
```

`Schema.parseJson` combines JSON parsing and schema validation in a single step — typed end-to-end, no untyped intermediate.

## PRService/ — Orchestration

### Context Capture + Provide Pattern

PRServiceLive captures the full service context at construction, then provides it to sub-effects:

```typescript
// PRService/index.ts — captures context, provides to split methods
export const PRServiceLive = Layer.effect(
  PRService,
  Effect.gen(function*() {
    const ctx = yield* Effect.context<
      ConfigService | AwsClient | NotificationsService
      | PullRequestRepo | CommentRepo | NotificationRepo
      | SubscriptionRepo | SyncMetadataRepo
    >()
    const state = yield* SubscriptionRef.make<AppState>({ ... })

    const provide = <A, E>(effect: Effect.Effect<A, E, ...>) =>
      Effect.provide(effect, ctx)

    return {
      state,
      refresh: provide(makeRefresh(state)),          // state as param, services via R channel
      refreshSinglePR: (a, p) => provide(makeRefreshSinglePR(state)(a, p)),
      // ...
    }
  })
)
```

Split methods (e.g. `makeRefresh`) take `state: PRState` as a parameter and access services via `yield*` from the R channel. The Layer captures context once; `provide` supplies it to each method call.

### Clock.currentTimeMillis — Testable Time

```typescript
const now = yield * Clock.currentTimeMillis
const date = DateTime.toDate(DateTime.unsafeMake(now))
```

`Clock.currentTimeMillis` is mockable in tests via `TestClock` — pure, deterministic time access.

### Ref for Mutable State in refresh.ts

refresh.ts uses `Ref` for Effect-managed mutable state instead of raw `Map`/`Set`:

```typescript
// Ref-managed state — referentially transparent, safe under concurrency
const accountIdRef = yield* Ref.make(new Map<string, string>())
yield* Effect.forEach(accounts, (a) =>
  awsClient.getCallerIdentity(...).pipe(
    Effect.tap((id) => Ref.update(accountIdRef, (m) => new Map(m).set(a.profile, id.accountId)))
  ),
  { concurrency: 3 }
)
// Snapshot after population — read-only from here
const accountIdMap = yield* Ref.get(accountIdRef)
```

Three Refs in refresh:

- `accountIdRef` — profile→awsAccountId mapping (populated once, then snapshotted read-only)
- `subscribedRef` — subscribed PR keys (loaded from DB, grows during auto-subscribe)
- `seenKeysRef` — tracks seen PRs in current refresh (for stale PR removal)

### Incremental Streaming in refresh.ts

refresh.ts streams PRs incrementally into app state. Not batch-then-display — each PR appears as it arrives:

```typescript
yield *
  Stream.mergeAll(streams, { concurrency: 2 }).pipe(
    Stream.runForEach(({ label, pr, awsAccountId }) =>
      Effect.gen(function* () {
        yield* Ref.update(seenKeysRef, (s) => new Set(s).add(`${pr.account.profile}:${pr.id}`))
        const subscribed = yield* Ref.get(subscribedRef)
        if (awsAccountId && subscribed.has(`${awsAccountId}:${pr.id}`)) {
          // diff against cache for notifications
        }
        // upsert to cache, update SubscriptionRef state
      })
    )
  )
```

Key patterns:

1. **Stream.mergeAll(streams, { concurrency: 2 })** — interleaves multiple account/region streams with concurrency cap of 2
2. **Stream.runForEach** — processes each PR as it arrives (not `runCollect` which waits for all)
3. **SubscriptionRef.update** — atomic state update per PR, UI reactively re-renders
4. **Ref.update/Ref.get** — Effect-managed mutable state within the refresh lifecycle
5. **Insertion sort by creationDate** — maintains sorted order without re-sorting the full array

## CacheService/ — SQLite Cache Layer

### Architecture

```
CacheService/
├── Database.ts       ← DatabaseLive layer (libsql connection + migrations)
├── diff.ts           ← diffPR / diffComments → NewNotification[]
├── repos/
│   ├── PullRequestRepo.ts    ← SqlSchema-based CRUD + FTS5 search
│   ├── CommentRepo.ts        ← JSON-stored comments with Schema decode
│   ├── NotificationRepo.ts   ← Persistent notifications (read/unread)
│   ├── SubscriptionRepo.ts   ← PR subscriptions (SqlSchema)
│   └── SyncMetadataRepo.ts   ← Last-synced timestamps (SqlSchema)
└── migrations/               ← SQL schema migrations
```

### Effect.Service with dependencies

Each repo uses `Effect.Service` with `dependencies: [DatabaseLive]`:

```typescript
export class PullRequestRepo extends Effect.Service<PullRequestRepo>()("PullRequestRepo", {
  dependencies: [DatabaseLive],  // auto-wires DatabaseLive (SqlClient)
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const findAll = SqlSchema.findAll({ Result: CachedPullRequest, ... })
    return { findAll: () => findAll(undefined as void).pipe(Effect.orDie), ... }
  })
}) {}
```

### SqlSchema for Type-Safe Queries

All repos use `SqlSchema.findAll`/`SqlSchema.findOne`/`SqlSchema.void` for compile-time validated queries:

```typescript
// SubscriptionRepo — SqlSchema-based
const findAll_ = SqlSchema.findAll({
  Result: SubscriptionRow,
  Request: Schema.Void,
  execute: () =>
    sql`SELECT aws_account_id AS "awsAccountId", pull_request_id AS "pullRequestId"
        FROM pr_subscriptions`
})
```

### CommentRepo — Schema.parseJson on Read

Cached comments are stored as JSON strings. On read, `Schema.parseJson` combines JSON parsing + Schema validation in one step:

```typescript
const LocationsFromJson = Schema.parseJson(Schema.Array(PRCommentLocationJson))

find: (awsAccountId, prId) =>
  find_({ awsAccountId, pullRequestId: prId }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none()),
        onSome: (r) =>
          Schema.decodeUnknown(LocationsFromJson)(r.locationsJson).pipe(
            Effect.map((decoded) => Option.some(decoded)),
            Effect.catchAll(() => Effect.succeed(Option.some([]))) // corrupt data → empty
          )
      })
    ),
    Effect.orDie
  )
```

## index.ts — Namespace Re-exports

```typescript
export * as AwsClient from "./AwsClient/index.js"
export * as ConfigService from "./ConfigService/index.js"
export * as Domain from "./Domain.js"
// Consumer: import { Domain, AwsClient } from "@knpkv/codecommit-core"
```

Namespaces prevent name collisions and make imports self-documenting.

## Testing with @effect/vitest

### Setup

```
vitest.config.ts  — mergeConfig(shared, defineConfig({}))
test/
├── DateUtils.test.ts            <- Pure functions
├── ConfigService.internal.test.ts <- Pure INI parsing
├── AwsClient.internal.test.ts   <- Pure helpers (normalizeAuthor, isThrottlingError)
├── Domain.test.ts               <- Schema.Class decode + computed properties
├── Schema.transforms.test.ts    <- Bidirectional Schema roundtrips
├── Errors.test.ts               <- TaggedError yieldability + catchTag
├── NotificationsService.test.ts <- Service + TestClock
└── ConfigService.test.ts        <- Service + mocked FileSystem Layer
```

### `it.effect` — Effect-native test runner

Runs an Effect as a test. Automatically provides `TestServices` (TestClock, TestRandom, etc).

```typescript
import { describe, expect, it } from "@effect/vitest"

it.effect("decodes valid PR", () =>
  Effect.gen(function* () {
    const pr = yield* Schema.decode(PullRequest)(validInput)
    expect(pr.id).toBe("123")
  })
)
```

### `it.layer` — Shared Layer for test suite

Provides a Layer to all `it.effect` calls within its scope. Layers are memoized per `describe` block — service construction happens once.

```typescript
it.layer(NotificationsServiceLive)((it) => {
  it.effect("adds notification", () =>
    Effect.gen(function* () {
      const svc = yield* NotificationsService
      yield* svc.add({ type: "info", title: "T", message: "M" })
      // ...
    })
  )
})
```

### TestClock for deterministic timestamps

Services using `Clock.currentTimeMillis` are testable with `TestClock.adjust`:

```typescript
it.effect("uses TestClock for timestamp", () =>
  Effect.gen(function*() {
    yield* TestClock.adjust("10 seconds")
    yield* service.add(...)
    const state = yield* SubscriptionRef.get(service.state)
    expect(state.items[0]!.timestamp.getTime()).toBe(10_000)
  }))
```

### Mocking services with Layer.succeed

For services backed by platform abstractions (FileSystem, HttpClient), create mock layers:

```typescript
const MockFS = Layer.succeed(
  FileSystem.FileSystem,
  FileSystem.FileSystem.of({
    exists: (path) => Effect.succeed(path in files),
    readFileString: (path) => Effect.succeed(files[path]!),
    writeFileString: () => Effect.void,
    makeDirectory: () => Effect.void
  } as any)
)

const TestLayer = ConfigServiceLive.pipe(Layer.provide(Layer.merge(MockFS, Path.layer)))
```

### Best practices

1. **Pure functions first** — test `normalizeAuthor`, `parseAwsConfig`, `formatDate` directly without Effect
2. **Schema roundtrip** — always test decode→encode→decode for bidirectional transforms
3. **it.effect for Effect code** — never use `Effect.runPromise` manually; `it.effect` handles lifecycle
4. **it.layer for services** — avoids repeating `Effect.provide(...)` in every test
5. **TestClock over real time** — any service using `Clock` should be tested with `TestClock.adjust`
6. **Mock at service boundary** — mock `FileSystem`, `HttpClient`, never mock internal helpers
7. **Test error paths** — use `Effect.flip` to assert on failure channel
8. **Comment every test** — describe WHY the test exists, not WHAT it does

## Gotchas

1. **exactOptionalPropertyTypes** — `filePath: string | undefined` != `filePath?: string`. Use conditional spread: `...(x != null ? { filePath: x } : {})`
2. **module: NodeNext** — directory imports need explicit `/index.js`
3. **Linter + type imports** — ESLint may incorrectly change value imports to `import type`. Split into separate import statements if needed.
4. **Schema.Class context** — `Schema.decodeUnknownEither(MyClass)` requires `Context = never`. If you see context type errors, check your Schema fields.

## Further Reading

- [Schema.Class](https://effect.website/docs/data-types/schema/classes/)
- [Schema.TaggedError](https://effect.website/docs/error-management/expected-errors/)
- [Stream.paginateEffect](https://effect.website/docs/streaming/stream/creating/)
- [Match.value](https://effect.website/docs/data-types/match/)
