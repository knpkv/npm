# Effect Explainer: codecommit (TUI)

TUI architecture — how Effect-Atom bridges React and Effect worlds.

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   React Components                   │
│  (App, MainList, SettingsTable, DetailsView, ...)   │
└──────────┬───────────────────────────────┬──────────┘
           │ useAtom(appStateAtom)         │ useAtom(refreshAtom).write()
           ▼                               ▼
┌──────────────────────────────────────────────────────┐
│                    Atoms Layer                        │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐ │
│  │ appState   │  │ refresh    │  │ actions         │ │
│  │ (read)     │  │ (write)    │  │ (login, open,   │ │
│  │            │  │            │  │  create, list)  │ │
│  └────────────┘  └────────────┘  └────────────────┘ │
│         ▲               │               │            │
│         │     runtimeAtom.fn / .subscribable         │
└─────────┼───────────────┼───────────────┼────────────┘
          │               ▼               ▼
┌─────────────────────────────────────────────────────┐
│                 Effect Runtime                        │
│  ┌──────────┐ ┌──────────────┐ ┌──────────────────┐ │
│  │PRService │ │AwsClient     │ │CacheService       │ │
│  │ .refresh │ │ withAws-     │ │ PullRequestRepo   │ │
│  │ .toggle  │ │   Context    │ │ NotificationRepo  │ │
│  │ .setAll  │ │              │ │ EventsHub (PubSub)│ │
│  └──────────┘ └──────────────┘ └──────────────────┘ │
│                                                      │
│  Provided by: AppLayer (BunContext + FetchHttp +     │
│               AwsClientConfig.Default + AwsClientLive│
│               + ConfigServiceLive + PRServiceLive +  │
│               ReposLive + EventsHubLive)              │
└─────────────────────────────────────────────────────┘
```

## The Bridge: Effect-Atom

Effect-Atom solves the fundamental mismatch:

- **React** wants synchronous state snapshots with re-renders
- **Effect** wants typed, cancellable, async computations

### Three Atom Patterns

#### 1. `runtimeAtom.subscribable` — Read reactive Effect state

```typescript
// Subscribes to SubscriptionRef changes, re-renders React on each update
export const appStateAtom = runtimeAtom.subscribable(
  Effect.gen(function* () {
    const prService = yield* PRService
    return prService.state // SubscriptionRef<AppState>
  })
)
// In React: const [state] = useAtom(appStateAtom)
```

#### 2. `runtimeAtom.fn` — Write (trigger Effect side-effects)

```typescript
// Wraps an Effect function as a writable atom
export const refreshAtom = runtimeAtom.fn(
  Effect.fnUntraced(function* () {
    const prService = yield* PRService
    yield* Effect.forkDaemon(prService.refresh)
  })
)
// In React: const [_, refresh] = useAtom(refreshAtom); refresh()
```

#### 3. `runtimeAtom.fn` with params — Parameterized actions

```typescript
export const loginToAwsAtom = runtimeAtom.fn((profile: string) =>
  Effect.gen(function* () {
    // profile comes from React, Effect handles the rest
    yield* Command.make("aws", "sso", "login", "--profile", profile)
  })
)
// In React: login("my-profile")
```

## Layer Composition in runtime.ts

The TUI runtime wires CacheService repos (SQLite) alongside AWS and config services:

```typescript
// EventsHub — PubSub for cache invalidation, shared across repos
const EventsHubLive = CacheService.EventsHub.Default

const AwsLive = AwsClient.AwsClientLive.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AwsClientConfig.Default)
)

const ConfigLayer = ConfigService.ConfigServiceLive.pipe(
  Layer.provide(BunContext.layer),
  Layer.provide(EventsHubLive) // ConfigService publishes changes to EventsHub
)

// All repos share DatabaseLive via Effect.Service dependencies (auto-wired)
// BunContext provides FileSystem for DB directory creation
const ReposLive = Layer.mergeAll(
  CacheService.PullRequestRepo.Default,
  CacheService.CommentRepo.Default,
  CacheService.NotificationRepo.Default,
  CacheService.SubscriptionRepo.Default,
  CacheService.SyncMetadataRepo.Default
).pipe(Layer.provide(BunContext.layer))

// PRService orchestrates AWS calls → cache upserts → EventsHub notifications
const PRLayer = PRService.PRServiceLive.pipe(
  Layer.provide(AwsLive),
  Layer.provide(ConfigLayer),
  Layer.provide(ReposLive),
  Layer.provide(EventsHubLive)
)

// Expose PRService + repos + EventsHub + AwsClient for atoms
const AppLayer = Layer.mergeAll(PRLayer, ReposLive, EventsHubLive, AwsLive).pipe(Layer.provideMerge(BunContext.layer))

export const runtimeAtom = Atom.runtime(AppLayer)
```

Layer memoization ensures `EventsHubLive` is built once and shared — repos and PRService both subscribe to the same PubSub instance.

## CLI Architecture (bin.ts)

```
codecommit [command]
├── (default) → TUI (dynamic import ./main.js)
├── web       → Web server (codecommit-web)
└── pr
    ├── list   → Stream PRs to terminal
    ├── create → Create PR via AwsClient
    ├── export → Export PR comments as markdown
    └── update → Update PR title/description
```

Each CLI command builds its own Layer and runs `Effect.runPromise`.
The TUI command uses `Atom.runtime` for reactive state; CLI commands use one-shot Effects.

## Key Patterns

### Fiber Management for Refresh

```typescript
let activeRefreshFiber: Fiber.RuntimeFiber<void, unknown> | null = null

// Before starting new refresh, interrupt previous
if (activeRefreshFiber) {
  yield * Fiber.interrupt(activeRefreshFiber)
}
activeRefreshFiber = yield * Effect.forkDaemon(prService.refresh)
```

`forkDaemon` ensures the refresh survives the parent scope (atom callback).
Manual tracking enables cancellation on re-trigger or cleanup.

### Incremental Refresh via Stream

Refresh streams PRs incrementally — each PR updates state as it arrives (per-PR `SubscriptionRef.update`), not in a batch. Streams from all enabled account/region pairs are merged with bounded concurrency:

```typescript
yield *
  Stream.mergeAll(streams, { concurrency: 2 }).pipe(
    Stream.runForEach(({ label, pr }) =>
      SubscriptionRef.update(deps.state, (s) => {
        // Insert PR in sorted position by creationDate
        const insertIdx = prs.findIndex((p) => p.creationDate.getTime() < pr.creationDate.getTime())
        return { ...s, pullRequests: [...before, pr, ...after] }
      })
    )
  )
```

The UI updates progressively as PRs are fetched. Error streams use `Stream.execute` (run an Effect, emit zero elements) for side-effect-only error handling — replacing the older `Stream.fromEffect(...).pipe(Stream.flatMap(() => Stream.empty))` pattern.

### CacheService Integration

PRs fetched from AWS are diffed against SQLite cache, upserted, and changes published via `EventsHub`:

```
AWS → Stream<PR> → diff(cached) → upsert(repo) → EventsHub.publish
                                                         │
                      SubscriptionRef.changes ←──────────┘
                              │
                    React re-render via atom
```

The `EventsHub.batch` wrapper accumulates repo change events during refresh and publishes them once at the end — preventing UI flicker from per-PR notifications.

### Cross-Platform Commands

```typescript
const cmd = process.platform === "darwin" ? Command.make("pbcopy") : Command.make("xclip", "-selection", "clipboard")

yield * Command.exitCode(Command.stdin(cmd, Stream.make(text).pipe(Stream.encodeText)))
```

`@effect/platform` Command is type-safe, composable, and handles stdin/stdout as Streams.

## Gotchas

1. **`Effect.fnUntraced` in atoms** — `runtimeAtom.fn(Effect.fnUntraced(...))` gives proper type inference without capturing the React call stack in traces. `Effect.fn` would record React reconciler/scheduler frames — useless noise. Explicit `Effect.withSpan` inside each atom provides meaningful tracing instead.
2. **`Effect.fn` in core services** — PRService methods (`refresh`, `refreshSinglePR`, `toggleAccount`, `setAllAccounts`) use `Effect.fn("span")(function*(...) { ... })` for automatic span creation + better stack traces. This is the idiomatic pattern for services (vs atoms where `fnUntraced` is preferred).
3. **No `as any` casts** — All atom type annotations removed; inference handles the `AtomResultFn` generics. Errors narrowed to `never` via exhaustive `Effect.catchTag` per error tag.
4. **Layer memoization** — `Layer.merge` shares instances. `EventsHubLive` appears in both `ConfigLayer` and `PRLayer` deps — memoization ensures only one PubSub is created.
5. **`Schema.encode` vs `encodeSync`** — Always use the Effect-based `Schema.encode`/`Schema.decode` in Effect pipelines. `encodeSync`/`decodeSync` throw synchronous exceptions that become defects (unrecoverable). Wrap in lambda for `Effect.forEach`: `(row) => Schema.encode(MySchema)(row)` (the optional `overrideOptions` param conflicts with forEach's index param).

## Further Reading

- [Effect-Atom](https://github.com/effect-ts/atom)
- [Effect CLI](https://effect.website/docs/cli/)
- [@effect/platform Command](https://effect.website/docs/platform/command/)
