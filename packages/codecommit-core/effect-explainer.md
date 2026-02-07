# Effect Explainer: codecommit-core

Service architecture overview — why Effect services beat DI frameworks.

## Dependency Graph

```
                    ┌─────────────────┐
                    │   PRService      │
                    │  (orchestrator)  │
                    └──┬──┬──┬────────┘
                       │  │  │
          ┌────────────┘  │  └────────────┐
          ▼               ▼               ▼
  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
  │  AwsClient   │ │ConfigService │ │NotificationsService│
  │  (8 methods) │ │(load/save/   │ │  (add/clear/state) │
  │              │ │ detect)      │ │                    │
  └──────┬───────┘ └──────┬───────┘ └────────────────────┘
         │                │
         ▼                ▼
  ┌──────────────┐ ┌──────────────┐
  │AwsClientConfig│ │  FileSystem  │
  │  (timeouts,  │ │  Path        │
  │   retries)   │ │  (platform)  │
  └──────────────┘ └──────────────┘
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

### Context-Scoped Dependencies (Effect.provide + Layer.mergeAll)

Every AwsClient method follows the same scoping pattern:

```typescript
// createPullRequest.ts — representative pattern used in ALL methods
export const createPullRequest = (params: CreatePullRequestParams) =>
  Effect.gen(function*() {
    const config = yield* AwsClientConfig          // read config from context
    const httpClient = yield* HttpClient.HttpClient // read HttpClient from context
    const credentials = yield* acquireCredentials(params.account.profile, params.account.region)

    return yield* Effect.provide(
      callCreatePullRequest(params),               // inner effect needing AWS deps
      Layer.mergeAll(                              // scope AWS deps to this call
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(Region.Region, params.account.region),
        Layer.succeed(Credentials.Credentials, credentials)
      )
    ).pipe(
      throttleRetry,                               // retry on throttle (reads AwsClientConfig)
      Effect.timeout(config.operationTimeout),
      Effect.catchTag("TimeoutException", (cause) =>
        Effect.fail(makeApiError("createPullRequest", ...)))
    )
  })
```

Why `Effect.provide` + `Layer.mergeAll` instead of individual `provideService` calls:

- Scopes all 3 AWS deps (HttpClient, Region, Credentials) to one inner effect
- Credentials are per-call (different profile/region per account)
- Inner effects (from `distilled-aws`) declare their deps; `Layer.mergeAll` satisfies all at once
- Stream variant uses `Stream.provideService` (see `getPullRequests.ts`)

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
└── RefreshError          — PR refresh orchestration
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
      SubscriptionRef.update(deps.state, (s) => {
        // insert PR sorted by creationDate — UI updates per-PR
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
