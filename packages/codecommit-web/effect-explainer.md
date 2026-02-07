# Effect Explainer: codecommit-web

Full-stack Effect — HttpApi pattern, typed endpoints, layer composition for servers.

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                  Browser (React SPA)             │
│  EventSource("/api/events/") → SSE (real-time)   │
│  fetch("/api/prs") → JSON (query atoms)          │
└────────────────────┬────────────────────────────┘
                     │ HTTP
                     ▼
┌─────────────────────────────────────────────────┐
│              Bun HTTP Server                     │
│  ┌───────────────────────────────────────────┐  │
│  │  Static Files (SPA)                       │  │
│  │  /index.html, /assets/*.js, *.css         │  │
│  └───────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────┐  │
│  │  HttpApi Router                           │  │
│  │  /api/prs/*      → PrsLive handlers       │  │
│  │  /api/events/    → EventsLive (SSE stream) │  │
│  │  /api/config     → ConfigLive handlers    │  │
│  │  /api/accounts   → AccountsLive handlers  │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  Services: PRService, ConfigService, AwsClient,  │
│            NotificationsService                  │
└─────────────────────────────────────────────────┘
```

## HttpApi — Declarative Endpoint Definition

```typescript
// Api.ts — declares WHAT endpoints exist
class PrsGroup extends HttpApiGroup.make("prs").pipe(
  HttpApiGroup.add(HttpApiEndpoint.get("list", "/list")),
  HttpApiGroup.add(HttpApiEndpoint.post("refresh", "/refresh")),
  HttpApiGroup.add(HttpApiEndpoint.post("create", "/create")),
  HttpApiGroup.prefix("/api/prs")
) {}

class CodeCommitApi extends HttpApi.make("codecommit-api").pipe(
  HttpApi.addGroup(PrsGroup),
  HttpApi.addGroup(EventsGroup)
  // ...
) {}
```

### Why HttpApi Over Express-Style Routing?

| Express Style         | HttpApi Style                  |
| --------------------- | ------------------------------ |
| Routes = strings      | Routes = typed schemas         |
| Errors = throw        | Errors = typed Effect failures |
| Middleware = mutation | Middleware = Layer composition |
| Testing = supertest   | Testing = provide mock layers  |

## Layer Composition for Servers

```typescript
// Server.ts — provides services to all handlers
const CodeCommitServerLive = HttpApiBuilder.api(CodeCommitApi).pipe(
  // Register handler implementations
  Layer.provide(PrsLive),
  Layer.provide(ConfigLive),
  Layer.provide(AccountsLive),
  Layer.provide(EventsLive),
  // Provide services that handlers need
  Layer.provide(PRServiceLive),
  Layer.provide(AwsClientLive),
  Layer.provide(AwsClientConfig.Default), // required by AwsClientLive
  Layer.provide(ConfigServiceLive),
  Layer.provide(NotificationsServiceLive),
  // Platform
  Layer.provide(BunContext.layer),
  Layer.provide(FetchHttpClient.layer)
)
```

Every handler gets its services through layers — no global state, no singletons.

## Static File Serving

```typescript
// Custom middleware for SPA static files
const serveStatic = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const urlPath = new URL(request.url).pathname
    // Security: reject path traversal
    if (urlPath.includes("..")) return yield* app
    // Try static file, fall back to index.html (SPA)
    const filePath = path.join(clientDir, urlPath)
    if (fs.existsSync(filePath)) return serveFile(filePath)
    return serveFile(path.join(clientDir, "index.html"))
  })
)
```

Note: Currently uses sync `fs` — target: migrate to `@effect/platform FileSystem` (async).

## Server-Sent Events (SSE)

### Implementation: handleRaw + SubscriptionRef.changes

```typescript
// events-live.ts — Schema-encoded SSE streaming

// Schema for wire format
const SsePayload = Schema.Struct({
  pullRequests: Schema.Array(PullRequest),
  accounts: Schema.Array(AccountState),
  status: AppStatus,
  ...
})
const encode = Schema.encodeSync(SsePayload)

// handleRaw bypasses schema response encoding → raw HttpServerResponse
export const EventsLive = HttpApiBuilder.group(CodeCommitApi, "events", (handlers) =>
  Effect.gen(function*() {
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
          { headers: { "content-type": "text/event-stream", ... } }
        )
      ))
  }))
```

### Client: useSSE Hook

```typescript
// hooks/useSSE.ts — EventSource → atom updates
export function useSSE(onState: (state: AppState) => void) {
  const callbackRef = useRef(onState)
  callbackRef.current = onState

  useEffect(() => {
    const es = new EventSource("/api/events/")
    es.onmessage = (event) => {
      try {
        callbackRef.current(JSON.parse(event.data))
      } catch {
        /* ignore parse errors */
      }
    }
    return () => es.close()
  }, [])
}

// App.tsx — wires SSE into appStateAtom
const setAppState = useAtomSet(appStateAtom)
useSSE((state) => setAppState(state))
```

### Why handleRaw?

`handle()` encodes the response through the endpoint's success Schema. SSE needs
raw `text/event-stream` response with streaming body — `handleRaw()` returns
`HttpServerResponse` directly, bypassing schema encoding.

### Why SubscriptionRef.changes (Not PubSub)?

`prService.state` is already a `SubscriptionRef<AppState>`. `.changes` gives a
`Stream<AppState>` that emits the current value + all subsequent updates — exactly
what SSE needs. No PubSub wiring, no daemon fork, no missed events.

## Shared State: PRService Across TUI and Web

Both TUI and Web share the same PRService:

```
TUI:  runtimeAtom → PRService → SubscriptionRef<AppState>
Web:  Handler      → PRService → SubscriptionRef<AppState>
```

The `SubscriptionRef` is the single source of truth. Web handlers read from it directly:

```typescript
// prs-live.ts
HttpApiBuilder.handle("list", () =>
  SubscriptionRef.get(prService.state).pipe(Effect.map((state) => Chunk.fromIterable(state.pullRequests)))
)
```

### Incremental PR Streaming During Refresh

Refresh updates the `SubscriptionRef` per-PR (not batch). Each PR is inserted in
creation-date order as it arrives from AWS streams (concurrency 2). SSE clients
receive each intermediate state update in real-time via `SubscriptionRef.changes`.

## Client Deep Imports

Client code imports from `@knpkv/codecommit-core` using deep subpath imports to
avoid pulling in server-only dependencies (distilled-aws, @aws-sdk):

```typescript
// ✓ Deep import — only pulls in DateUtils module
import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"

// ✗ Barrel import — pulls in AwsClient → distilled-aws → browser error
import { DateUtils } from "@knpkv/codecommit-core"
```

Package.json exports pattern `"./*.js": "./src/*.ts"` enables these deep imports.

## Logging Strategy

### Use `Effect.log*` — Not `console.log`

Effect's structured logging integrates with fibers, spans, and layers:

```typescript
// Levels: logTrace → logDebug → logInfo → logWarning → logError → logFatal
yield * Effect.logInfo("Starting server")
yield * Effect.logWarning(`Port ${port} in use`)
yield * Effect.logError("Server error", cause)
```

### Log Annotations — Structured Context

```typescript
// Attach key-value pairs to all logs within the scope
Effect.gen(function* () {
  yield* Effect.logInfo("Refreshing PRs")
  yield* Effect.logInfo("Done")
}).pipe(Effect.annotateLogs({ account: profile, region }))
// Both logs include { account: "foo", region: "eu-west-1" }
```

### Log Spans — Timing

```typescript
prService.refresh.pipe(Effect.withLogSpan("pr-refresh"))
// Logs include: pr-refresh=1234ms
```

### Logger Layers

Replace the default console logger at the top level:

```typescript
import { Logger } from "effect"

// JSON structured output (good for log aggregators)
program.pipe(Effect.provide(Logger.json))

// Pretty console output (good for dev)
program.pipe(Effect.provide(Logger.pretty))

// Minimum log level
program.pipe(Logger.withMinimumLogLevel(LogLevel.Debug))
```

### Rules

1. **Never `console.log`** in Effect code — use `Effect.logInfo` etc.
2. **Use `Effect.logWarning`** for recoverable issues (port in use, retry)
3. **Use `Effect.logError` with `Cause`** for failures — preserves stack + fiber info
4. **Annotate** with contextual fields (`account`, `port`, `endpoint`)
5. **Log spans** for operations you want to time

## Gotchas

1. **CORS** — Must be enabled explicitly: `HttpApiBuilder.middlewareCors({ allowOrigin: "*" })`
2. **Static files vs API** — Static middleware runs first; API router handles `/api/*`. Order matters.
3. **Bun vs Node** — Server uses `@effect/platform-bun`. For Node deployment, swap to `@effect/platform-node`.
4. **SSE cleanup** — When client disconnects, the SubscriptionRef stream is interrupted automatically.
5. **Client barrel imports** — Never import from `@knpkv/codecommit-core` barrel in client code; use deep imports to avoid bundling server-only deps.

## Server Startup Patterns

### Port Retry — Catch Defect, Recurse

Bun throws a defect (not typed error) when a port is in use. Convert and retry:

```typescript
const startServer = (port: number): Effect.Effect<never> =>
  Effect.logInfo(`Starting on http://localhost:${port}`).pipe(
    Effect.andThen(Effect.suspend(() => Layer.launch(makeServer({ port })))),
    Effect.catchAllDefect((defect) =>
      defect instanceof Error && defect.message.includes("port") && port < 3010
        ? Effect.logWarning(`Port ${port} in use`).pipe(Effect.andThen(startServer(port + 1)))
        : Effect.die(defect)
    )
  )
```

### Initial Refresh — Layer Sibling Sharing

To run a startup effect that shares services with handlers, merge it as a sibling
under the same provider — not as a separate layer with its own `Layer.provide`:

```typescript
// InitialRefresh requires PRService from context (no own provision)
const InitialRefresh = Layer.effectDiscard(
  Effect.gen(function* () {
    const prService = yield* PRService.PRService
    yield* Effect.forkDaemon(prService.refresh)
  })
)

// Merged alongside API handlers — both share AllServicesLive
const ApiLive = Layer.merge(
  HttpLayerRouter.addHttpApi(CodeCommitApi).pipe(Layer.provide(HandlersLive)),
  InitialRefresh
).pipe(Layer.provide(AllServicesLive))
```

If `InitialRefresh` had its own `Layer.provide(PRServiceLive_)`, it would create a
separate PRService instance — refreshing a state that no handler reads from.

## Further Reading

- [HttpApi](https://effect.website/docs/platform/http-api/)
- [HttpApiBuilder](https://effect.website/docs/platform/http-api-builder/)
- [SubscriptionRef](https://effect.website/docs/state-management/subscription-ref/)
