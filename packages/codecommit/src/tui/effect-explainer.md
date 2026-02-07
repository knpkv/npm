# Effect Explainer: TUI Component Layer

Component-to-Effect data flow, fiber lifecycle.

## Data Flow: React Component → Effect → React Component

```
┌─────────────────┐    useAtom(appStateAtom)    ┌───────────────────┐
│  MainList.tsx    │◄───────────────────────────│  appStateAtom      │
│                  │                             │  (subscribable)    │
│  onClick(pr) ────┼───── useAtom(openPrAtom) ──►│                   │
└─────────────────┘    .write(pr)               └────────┬──────────┘
                                                          │
                                                          │ SubscriptionRef
                                                          │ changes
                                                          ▼
                                                ┌───────────────────┐
                                                │  PRService.state   │
                                                │  (SubscriptionRef  │
                                                │   <AppState>)      │
                                                └───────────────────┘
```

### The Full Cycle

1. **User clicks refresh** → React calls `refresh.write()`
2. **Atom dispatches** → `runtimeAtom.fn` runs the Effect in the shared runtime
3. **Effect executes** → `PRService.refresh` streams PRs incrementally from AWS via `Stream.mergeAll(streams, { concurrency: 2 })`. Each PR triggers a `SubscriptionRef.update` (per-PR, not batch).
4. **SubscriptionRef emits** → `appStateAtom` (subscribable) detects change on each PR insertion
5. **React re-renders** → Components receive progressively updated `AppState`

## Component Categories

### Pure Display Components

```
Badge, Spinner, StatusRow, ListItemRow, Table
```

No Effect interaction. Receive props, render UI. Keep these pure.

### Stateful Components (via atoms)

```
MainList      — reads appStateAtom, writes selectedIndexAtom
SettingsTable — reads appStateAtom, writes toggleAccountAtom / setAllAccountsAtom
Header        — reads appStateAtom (status, lastUpdated)
Footer        — reads viewAtom, showHelpAtom
```

Pattern: `const [state] = useAtom(someAtom)` for reads, destructure `.write` for actions.

### Action-Triggering Components

```
DialogCreatePR — writes createPrAtom with form data
DialogCommand  — writes loginToAwsAtom with profile
```

These gather user input and dispatch to action atoms.

## Fiber Lifecycle

### Problem: Long-Running Refresh

PR refresh can take 30-120 seconds (AWS pagination across repos). During this time:

- User might trigger another refresh
- User might exit the TUI
- Network might fail

### Solution: Daemon Fibers with Manual Tracking

```
User clicks refresh
        │
        ▼
┌──────────────────────┐     Previous fiber running?
│  refreshAtom.write() │────── Yes ──► Fiber.interrupt(old)
│                      │                      │
│                      │◄─────────────────────┘
│                      │
│  forkDaemon(refresh) │──► New fiber runs independently
│                      │    of atom callback scope
└──────────────────────┘
```

Why `forkDaemon`?

- Regular `fork` ties fiber to parent scope — atom callback completes instantly, killing the child
- `forkDaemon` detaches — fiber lives in the runtime, survives parent completion

### Cleanup on Exit

```typescript
// Called when TUI unmounts
export const cleanup = Effect.gen(function* () {
  if (activeRefreshFiber) {
    yield* Fiber.interrupt(activeRefreshFiber)
    activeRefreshFiber = null
  }
})
```

## View State Machine

```
         "prs" ◄──────► "details"
           │                 │
           ▼                 │
      "settings"             │
           │                 │
           ▼                 │
     "notifications" ◄───────┘
```

`viewAtom` controls which screen is active. Keyboard navigation switches views.
`selectedPrIdAtom` persists selection across view transitions.

## Hook Patterns

### useKeyboardNav

```typescript
// Maps keyboard events to atom writes
// 'r' → refreshAtom.write()
// 'enter' → viewAtom.write("details")
// 'q' → exitPendingAtom.write(true)
```

### useListNavigation

```typescript
// Manages selectedIndex within bounded list
// Up/Down arrows, Home/End, Page Up/Down
// Wraps around: last item → first item
```

## Gotchas

1. **Result.Result wrapper** — All atom reads return `Result.Result<T>`, not `T`. Handle loading/error states: `Result.isSuccess(state) ? state.value : fallback`
2. **Atom.keepAlive** — UI atoms use `keepAlive` to persist state when components unmount/remount. Without it, switching views would reset filter text.
3. **Stream vs Effect in atoms** — `subscribable` expects a `SubscriptionRef` (continuous). `fn` expects an `Effect` (one-shot). Don't mix them up.

## Fiber Fork Methods: fork vs forkDaemon vs forkScoped vs forkIn

Four fork variants control **how long a fiber lives** relative to its parent.

### Effect.fork — Child of Parent

Child fiber is interrupted when parent completes or is interrupted.

```typescript
// From actions.ts — openBrowserAtom
// The browser open is fast, so fork is fine: child dies with parent scope.
yield* Command.exitCode(cmd).pipe(
  Effect.catchAll((error) => /* notify */),
  Effect.fork,
  Effect.asVoid
)
```

```
Parent fiber ──────────────────┤ (completes)
  └── Child fiber ─────────────┤ (auto-interrupted)
```

### Effect.forkDaemon — Detached, Lives Forever

Fiber moves to root scope. Survives parent. Must be manually interrupted.

```typescript
// From app.ts — refreshAtom
// Atom callback returns immediately, but refresh takes 30-120s.
// forkDaemon keeps it alive. We track the fiber for manual cleanup.
activeRefreshFiber = yield* Effect.forkDaemon(prService.refresh)

// From actions.ts — loginToAwsAtom
// SSO login opens browser, takes minutes. Must outlive atom callback.
yield* Effect.forkDaemon(
  Command.exitCode(cmd).pipe(
    Effect.tap(() => service.addNotification({ type: "success", ... })),
    Effect.catchAll((e) => service.addNotification({ type: "error", ... }))
  )
)
```

```
Parent fiber ──────┤ (completes)
  └── Daemon fiber ──────────────────────────┤ (runs until done or manually interrupted)
```

### Effect.forkScoped — Bound to Nearest Scope

Fiber outlives the parent but is automatically interrupted when the enclosing `Scope` closes. No manual tracking needed.

```typescript
// Hypothetical: background poller cleaned up when service layer tears down
const poll = yield * Effect.forkScoped(Effect.repeat(fetchPRs, Schedule.spaced("30 seconds")))
// Scope.close() interrupts the poller automatically
```

```
Scope ──────────────────────────────────┤ (closes)
  Parent fiber ──────┤                   │
    └── Scoped fiber ───────────────────┤ (auto-interrupted by scope)
```

### Effect.forkIn — Fork into a Chosen Scope

Like `forkScoped` but you specify which `Scope` owns the fiber.

```typescript
const sharedScope = yield * Scope.make()
const fiber = yield * Effect.forkIn(longRunningTask, sharedScope)
// fiber lives until sharedScope is closed, regardless of parent
```

### Quick Reference

| Method       | Lifetime             | Cleanup                  | Best For                        |
| ------------ | -------------------- | ------------------------ | ------------------------------- |
| `fork`       | Parent               | Automatic                | Short parallel subtasks         |
| `forkDaemon` | Root scope (forever) | Manual `Fiber.interrupt` | Long-running fire-and-forget    |
| `forkScoped` | Nearest `Scope`      | Automatic                | Background work within services |
| `forkIn`     | Specified `Scope`    | Automatic                | Cross-cutting fiber ownership   |

### Why This Codebase Uses forkDaemon

All atom callbacks (`runtimeAtom.fn`) complete instantly — they're dispatched from React event handlers. Long-running operations (PR refresh, SSO login, assume) must survive the callback. `forkDaemon` detaches them. The trade-off: we must manually track and interrupt (see `activeRefreshFiber` in `app.ts` and `cleanup`).

The exception: `openBrowserAtom` uses plain `fork`. The `open`/`xdg-open` command returns quickly, so child-of-parent semantics are sufficient.

## Further Reading

- [SubscriptionRef](https://effect.website/docs/state-management/subscriptionref/)
- [Fiber](https://effect.website/docs/concurrency/fibers/)
- [Effect.forkDaemon](https://effect.website/docs/concurrency/fibers/#forking-effects)
