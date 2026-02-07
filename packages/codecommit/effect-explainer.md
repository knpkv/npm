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
│  │PRService │ │AwsClient     │ │NotificationsService│ │
│  │ .refresh │ │              │ │                    │ │
│  │ .toggle  │ │              │ │                    │ │
│  │ .setAll  │ │              │ │                    │ │
│  └──────────┘ └──────────────┘ └──────────────────┘ │
│                                                      │
│  Provided by: AppLayer (BunContext + FetchHttp +     │
│               AwsClientConfig.Default + AwsClientLive│
│               + ConfigServiceLive + PRServiceLive +  │
│               NotificationsServiceLive)               │
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

```typescript
// Each layer declares its requirements explicitly
const ConfigLayer = ConfigServiceLive.pipe(Layer.provide(BunContext.layer))
const PRLayer = PRServiceLive.pipe(
  Layer.provide(AwsClientLive),
  Layer.provide(ConfigLayer),
  Layer.provide(NotificationsServiceLive)
)

// Effect memoizes: ConfigService built once, shared everywhere
// AwsClientConfig.Default is required by AwsClientLive
const AppLayer = MainWithAwsLayer.pipe(
  Layer.provideMerge(BunContext.layer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AwsClientConfig.Default)
)
export const runtimeAtom = Atom.runtime(AppLayer)
```

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

This means the UI updates progressively as PRs are fetched, rather than waiting for all accounts to complete.

### Cross-Platform Commands

```typescript
const cmd = process.platform === "darwin" ? Command.make("pbcopy") : Command.make("xclip", "-selection", "clipboard")

yield * Command.exitCode(Command.stdin(cmd, Stream.make(text).pipe(Stream.encodeText)))
```

`@effect/platform` Command is type-safe, composable, and handles stdin/stdout as Streams.

## Gotchas

1. **`Effect.fnUntraced` in atoms** — `runtimeAtom.fn(Effect.fnUntraced(...))` gives proper type inference without capturing the React call stack in traces. `Effect.fn` would record React reconciler/scheduler frames — useless noise. Explicit `Effect.withSpan` inside each atom provides meaningful tracing instead.
2. **No `as any` casts** — All atom type annotations removed; inference handles the `AtomResultFn` generics. Errors narrowed to `never` via exhaustive `Effect.catchTag` per error tag.
3. **Layer memoization** — `Layer.merge` shares instances. Don't use `Layer.provide` twice with the same layer or you'll get two instances.

## Further Reading

- [Effect-Atom](https://github.com/effect-ts/atom)
- [Effect CLI](https://effect.website/docs/cli/)
- [@effect/platform Command](https://effect.website/docs/platform/command/)
