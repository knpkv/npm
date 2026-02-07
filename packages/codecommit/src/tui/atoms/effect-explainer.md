# Effect Explainer: TUI Atoms

Reactive state — SubscriptionRef to Atom to React, fiber management.

## The Three Layers of State

```
┌─────────────────────────────────────────────┐
│  React Layer (useAtom hooks)                │
│  Synchronous snapshots, triggers re-renders │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Atom Layer (Effect-Atom)                   │
│  Bridges async Effect world to sync React   │
│  subscribable = read, fn = write            │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Effect Layer (Services + SubscriptionRef)  │
│  Type-safe, cancellable, concurrent         │
└─────────────────────────────────────────────┘
```

## Atom Files

| File         | Purpose                                                            | Atom Types              |
| ------------ | ------------------------------------------------------------------ | ----------------------- |
| `runtime.ts` | Layer composition, creates `runtimeAtom`                           | `Atom.runtime`          |
| `app.ts`     | App-level state + actions (refresh, toggleAccount, setAllAccounts) | `subscribable` + `fn`   |
| `actions.ts` | User actions (AWS, clipboard, browser)                             | `fn` with params        |
| `ui.ts`      | Pure UI state (view, filter, selection)                            | `Atom.make` (no Effect) |

## runtime.ts — The Root

```typescript
// AwsClientConfig.Default is required by AwsClientLive
const AppLayer = MainWithAwsLayer.pipe(
  Layer.provideMerge(BunContext.layer), // FileSystem, CommandExecutor, Terminal, Path
  Layer.provide(FetchHttpClient.layer), // HttpClient for AWS API calls
  Layer.provide(AwsClientConfig.Default) // Default AWS client config
)

export const runtimeAtom = Atom.runtime(AppLayer)
```

`Atom.runtime(layer)` creates a managed Effect runtime. All other atoms access services through it:

- `runtimeAtom.subscribable(effect)` — continuous subscription
- `runtimeAtom.fn(effect)` — one-shot action

The runtime is created once, shared across all atoms. Layer memoization ensures each service is instantiated once.

## app.ts — SubscriptionRef → Atom → React

### Read Pattern: subscribable

```typescript
export const appStateAtom = runtimeAtom.subscribable(
  Effect.gen(function* () {
    const prService = yield* PRService
    return prService.state // SubscriptionRef<AppState>
  })
)
```

How this works:

1. Atom runs the Effect once to get the `SubscriptionRef`
2. Subscribes to all changes via `SubscriptionRef.changes`
3. Each new value → atom update → React re-render
4. Subscription cleaned up when atom is garbage collected

### Write Pattern: fn

```typescript
export const refreshAtom = runtimeAtom.fn(
  Effect.fnUntraced(function* () {
    if (activeRefreshFiber) {
      yield* Fiber.interrupt(activeRefreshFiber)
      activeRefreshFiber = null
    }
    const prService = yield* PRService
    activeRefreshFiber = yield* Effect.forkDaemon(prService.refresh)
  })
)
```

Calling `refreshAtom.write()` in React:

1. Runs the generator in the shared runtime
2. Has access to all services (PRService, etc.)
3. Returns immediately (fiber runs in background)
4. Refresh streams PRs incrementally (per-PR `SubscriptionRef.update`) via `Stream.mergeAll(streams, { concurrency: 2 })` — not batch

### PRService Account Management Atoms

```typescript
export const toggleAccountAtom = runtimeAtom.fn(
  Effect.fnUntraced(function* (profile: string) {
    const prService = yield* PRService.PRService
    yield* Effect.forkDaemon(prService.toggleAccount(profile))
  })
)

export const setAllAccountsAtom = runtimeAtom.fn(
  Effect.fnUntraced(function* (params: { enabled: boolean; profiles?: Array<string> }) {
    const prService = yield* PRService.PRService
    yield* Effect.forkDaemon(prService.setAllAccounts(params.enabled, params.profiles))
  })
)
```

Both toggle/setAll trigger a refresh after updating config.

## actions.ts — Parameterized Actions

```typescript
export const loginToAwsAtom = runtimeAtom.fn(
  Effect.fnUntraced(function* (profile: string) {
    const service = yield* PRService.PRService
    yield* Command.make("aws", "sso", "login", "--profile", profile)
  })
)
```

### Why Effect.fnUntraced (not Effect.fn)?

`Effect.fn` and `Effect.fnUntraced` both create an Effect-returning function with proper type inference — the difference is **tracing**.

`Effect.fn("name")` captures the call site stack trace and attaches it to spans. Useful when the caller is your own code. But atom callbacks are invoked by React internals (reconciler → scheduler → atom store → your function). That React stack is noise in traces — it tells you nothing useful about _your_ code.

`Effect.fnUntraced` skips capturing the call site, keeping traces clean. We still get tracing via explicit `Effect.withSpan` inside each atom:

```typescript
export const createPrAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*(input: CreatePRInput) {  // no call-site trace
    // ...
    const prId = yield* awsClient.createPullRequest({...}).pipe(
      Effect.withSpan("createPr", { attributes: { repo: input.repositoryName } })
      //             ^^^^^^^^^ explicit span — this IS useful
    )
  })
)
```

**Rule of thumb:** Use `Effect.fn` when the caller is your own code (services, helpers). Use `Effect.fnUntraced` when the caller is a framework (React, HTTP server, CLI runner) whose stack trace adds noise.

## ui.ts — Pure Atoms (No Effect)

```typescript
export const viewAtom = Atom.make<TuiView>("prs").pipe(Atom.keepAlive)
export const filterTextAtom = Atom.make("").pipe(Atom.keepAlive)
export const selectedIndexAtom = Atom.make(0).pipe(Atom.keepAlive)
```

These don't need Effect — they're simple synchronous state.
`Atom.keepAlive` prevents garbage collection when no React component is subscribed.

### Quick Filter System

```typescript
// Type-safe filter hierarchy
type QuickFilterType = "all" | "mine" | "account" | "author" | "scope" | "date" | "repo" | "status"

// Per-type values stored in a Record
const quickFilterValuesAtom = Atom.make<Record<QuickFilterType, string>>({
  all: "",
  mine: "",
  account: "",
  author: "",
  scope: "",
  date: "",
  repo: "",
  status: ""
}).pipe(Atom.keepAlive)
```

## Fiber Management Pattern

### Current: Mutable Variable

```typescript
let activeRefreshFiber: Fiber.RuntimeFiber<void, unknown> | null = null
```

### Target: Ref<Option<Fiber>>

```typescript
// Idiomatic Effect: no mutable state
const fiberRef = yield * Ref.make<Option.Option<Fiber.RuntimeFiber<void>>>(Option.none())

// Cancel previous
const prev = yield * Ref.get(fiberRef)
if (Option.isSome(prev)) yield * Fiber.interrupt(prev.value)

// Start new
const fiber = yield * Effect.forkDaemon(prService.refresh)
yield * Ref.set(fiberRef, Option.some(fiber))
```

Benefits:

- No mutable `let` — fully managed by Effect
- Thread-safe (Ref is atomic)
- Can live inside PRService instead of leaking to atoms

## Gotchas

1. **subscribable vs fn** — `subscribable` returns `Atom.Atom<Result<T>>` (read-only). `fn` returns `Atom.Writable<Result<A>, P>` (write with param P, read result A).
2. **forkDaemon scope** — Daemon fibers outlive their parent. You MUST track and interrupt them manually, or they'll leak.
3. **Layer order in merge** — `Layer.merge(A, B)` — if both provide the same service, A wins. Order matters.
4. **Result.Result** — Atoms wrap values in `Result.Result` which has three states: `Initial`, `Success`, `Failure`. Always handle all three in React.

## Fiber Fork Methods

Four ways to fork a fiber, each with different lifecycle semantics.

### Effect.fork — Child Fiber

Forked fiber is a **child** of the current fiber. When the parent completes or is interrupted, the child is interrupted too.

```typescript
// From actions.ts — openBrowserAtom
// fork is fine here: the atom callback waits for the parent scope,
// and the browser open is fast enough that we don't need it to outlive the parent.
yield* Command.exitCode(cmd).pipe(
  Effect.catchAll((error) => /* notify */),
  Effect.fork,
  Effect.asVoid
)
```

**Use when:** the child's work is short-lived or should die with the parent.

### Effect.forkDaemon — Detached Fiber

Forked fiber is **detached** from the parent and lives in the root scope. It survives parent completion. You must track and interrupt it manually.

```typescript
// From app.ts — refreshAtom
// forkDaemon because the atom callback returns immediately,
// but the refresh takes 30-120s and must keep running.
activeRefreshFiber = yield* Effect.forkDaemon(prService.refresh)

// From actions.ts — loginToAwsAtom
// forkDaemon because `aws sso login` opens a browser flow
// that outlives the atom callback.
yield* Effect.forkDaemon(
  Command.exitCode(cmd).pipe(
    Effect.tap(() => service.addNotification({ type: "success", ... })),
    Effect.catchAll((e) => service.addNotification({ type: "error", ... }))
  )
)
```

**Use when:** the work must outlive the parent. **Always** track the fiber for manual cleanup or it will leak.

### Effect.forkScoped — Scope-Bound Fiber

Forked fiber is tied to the nearest `Scope`. When that scope closes, the fiber is interrupted. Combines the detachment of `forkDaemon` with automatic cleanup.

```typescript
// Hypothetical: a background poller that should stop when the service layer tears down
const poll = yield * Effect.forkScoped(Effect.repeat(fetchPRs, Schedule.spaced("30 seconds")))
// No manual tracking needed — Scope.close interrupts it
```

**Use when:** the fiber should outlive the immediate parent but be cleaned up when a broader scope closes (e.g., service lifecycle, test teardown).

### Effect.forkIn — Fork into a Specific Scope

Like `forkScoped` but you choose exactly which `Scope` the fiber binds to.

```typescript
// Hypothetical: fork into a shared scope across multiple operations
const sharedScope = yield * Scope.make()
const fiber = yield * Effect.forkIn(longRunningTask, sharedScope)
// fiber lives until sharedScope is closed
```

**Use when:** you need fine-grained control over which scope manages the fiber's lifetime.

### Decision Table

| Method       | Lifetime                    | Cleanup                  | Use Case                           |
| ------------ | --------------------------- | ------------------------ | ---------------------------------- |
| `fork`       | Dies with parent            | Automatic                | Short tasks, parallel subtasks     |
| `forkDaemon` | Lives forever (root scope)  | Manual `Fiber.interrupt` | Fire-and-forget, long-running work |
| `forkScoped` | Dies with nearest `Scope`   | Automatic via scope      | Background work within a service   |
| `forkIn`     | Dies with specified `Scope` | Automatic via scope      | Cross-cutting fiber management     |

### This Codebase

All atom callbacks (`runtimeAtom.fn`) complete instantly. Any long-running work (refresh, SSO login, assume) uses `forkDaemon` because `fork` would kill the child when the callback returns. The one exception is `openBrowserAtom` which uses `fork` — the browser open command is fast and fire-and-forget within the callback scope.

## Further Reading

- [Effect-Atom docs](https://github.com/effect-ts/atom)
- [SubscriptionRef](https://effect.website/docs/state-management/subscriptionref/)
- [Ref](https://effect.website/docs/state-management/ref/)
