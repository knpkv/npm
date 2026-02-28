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
│  │  /api/prs/*              → PrsLive        │  │
│  │  /api/events/            → EventsLive     │  │
│  │  /api/config/*           → ConfigLive     │  │
│  │  /api/accounts           → AccountsLive   │  │
│  │  /api/notifications/*    → NotificationsLive│ │
│  │  /api/subscriptions/*    → SubscriptionsLive│ │
│  │  /api/notifications/persistent/* →          │ │
│  │       PersistentNotificationsLive           │ │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  Services: PRService, ConfigService, AwsClient,  │
│    NotificationsService, CacheService repos      │
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
// Server.ts — layer composition
const HandlersLive = Layer.mergeAll(
  PrsLive, ConfigLive, AccountsLive, EventsLive,
  NotificationsLive, SubscriptionsLive, PersistentNotificationsLive
)

const ReposLive = Layer.mergeAll(
  CacheService.PullRequestRepo.Default, CacheService.CommentRepo.Default,
  CacheService.NotificationRepo.Default, CacheService.SubscriptionRepo.Default,
  CacheService.SyncMetadataRepo.Default
).pipe(Layer.orDie)  // DB/migration errors → defects

const PRServiceDeps = Layer.mergeAll(AwsClient.AwsClientLive, ReposLive).pipe(
  Layer.provideMerge(ConfigLive_),
  Layer.provideMerge(NotificationsLive_),
  Layer.provide(AwsClientConfig.Default),
  Layer.provide(PlatformLive)
)

const AllServicesLive = Layer.mergeAll(PRServiceLive_, ConfigLive_, AwsClientLive_)

const ApiLive = Layer.merge(
  HttpLayerRouter.addHttpApi(CodeCommitApi).pipe(Layer.provide(HandlersLive)),
  AutoRefresh
).pipe(Layer.provide(AllServicesLive))

const AllRoutes = Layer.mergeAll(ApiLive, StaticRouter).pipe(
  Layer.provide(HttpLayerRouter.cors({ allowedOrigins: [...] })),
  Layer.orDie
)
```

Every handler gets its services through layers — no global state, no singletons.

## Static File Serving

Uses `@effect/platform FileSystem` (async, no sync `node:fs`):

```typescript
const serveStatic = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const url = new URL(req.url, "http://localhost")
  let filePath = url.pathname
  if (filePath.includes("..")) return HttpServerResponse.text("Forbidden", { status: 403 })

  const fullPath = path.join(staticDir, filePath)
  if (yield* fileSystem.exists(fullPath)) {
    const content = yield* fileSystem.readFile(fullPath)
    const ext = path.extname(fullPath)
    return HttpServerResponse.uint8Array(content, { status: 200, headers: { "content-type": mimeTypes[ext] } })
  }
  // SPA fallback → index.html
  const index = path.join(staticDir, "index.html")
  if (yield* fileSystem.exists(index)) {
    const content = yield* fileSystem.readFile(index)
    return HttpServerResponse.uint8Array(content, { status: 200, headers: { "content-type": "text/html" } })
  }
  return HttpServerResponse.text("Not Found", { status: 404 })
})
```

## Server-Sent Events (SSE)

### Implementation: handleRaw + Combined Change Streams

```typescript
// events-live.ts — merges PR + notification change streams with debounce

const encode = Schema.encode(SsePayload)  // Effect-based encode

export const EventsLive = HttpApiBuilder.group(CodeCommitApi, "events", (handlers) =>
  Effect.gen(function*() {
    const prService = yield* PRService.PRService
    const notificationsService = yield* NotificationsService.NotificationsService

    // Merge both change streams — tagged for selective DB queries
    const prChanges = prService.state.changes.pipe(Stream.map(() => "pr" as const))
    const notifChanges = notificationsService.state.changes.pipe(Stream.map(() => "notif" as const))

    // Ref-cached unread count — only re-queries DB on notification changes
    const lastUnreadRef = yield* Ref.make(
      yield* prService.getUnreadNotificationCount().pipe(Effect.catchAll(() => Effect.succeed(0)))
    )

    const stateStream = Stream.merge(prChanges, notifChanges).pipe(
      Stream.debounce(Duration.millis(200)),
      Stream.mapEffect((trigger) =>
        Effect.all({
          prState: SubscriptionRef.get(prService.state),
          notifState: SubscriptionRef.get(notificationsService.state),
          unreadCount: trigger === "notif"
            ? prService.getUnreadNotificationCount().pipe(
              Effect.tap((c) => Ref.set(lastUnreadRef, c)),
              Effect.catchAll(() => Ref.get(lastUnreadRef)))
            : Ref.get(lastUnreadRef)
        })
      ),
      Stream.mapEffect(({ prState, notifState, unreadCount }) =>
        encode({ ...prState, notifications: ..., unreadNotificationCount: unreadCount }).pipe(
          Effect.map((payload) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)),
          Effect.catchAll((e) =>
            Effect.logWarning("SSE encode failed", e).pipe(
              Effect.map(() => encoder.encode(":\n\n"))
            )
          )
        )
      )
    )

    // 30s keepalive prevents browser timeout
    return handlers.handleRaw("stream", () =>
      Effect.succeed(HttpServerResponse.stream(
        Stream.merge(stateStream, keepalive),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } }
      )))
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

## Config-Based CORS (S8)

CORS origins are configurable via `ALLOWED_ORIGINS` environment variable:

```typescript
const AllowedOrigins = Config.string("ALLOWED_ORIGINS").pipe(
  Config.map((s) => s.split(",")),
  Config.withDefault(["http://localhost:3000", "http://127.0.0.1:3000"])
)

const CorsLive = Layer.unwrapEffect(
  Effect.map(AllowedOrigins, (allowedOrigins) =>
    HttpLayerRouter.cors({
      allowedOrigins,
      allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"]
    })
  )
)
```

Uses `Config.withDefault` for local dev defaults, `Layer.unwrapEffect` to lift the config into a layer. Consistent with the `Port` config pattern.

## Effect-Based Schema.encode/decode in Handlers (C1)

Handlers use effectful `Schema.encode`/`Schema.decode` (not sync `encodeSync`/`decodeSync`):

```typescript
// config-live.ts — effectful branded type validation
const accounts =
  yield *
  Effect.forEach(payload.accounts, (a) =>
    Effect.all({
      profile: Schema.decode(AwsProfileName)(a.profile), // Effect-based
      regions: Effect.forEach(a.regions, (r) => Schema.decode(AwsRegion)(r)),
      enabled: Effect.succeed(a.enabled)
    })
  )

// prs-live.ts — effectful encoding of cache rows
const items =
  yield *
  Effect.forEach(
    result.items,
    (row) => Schema.encode(CacheService.CachedPullRequest)(row) // Effect-based
  )
```

Why effectful over sync: `Schema.decode`/`Schema.encode` return `Effect<A, ParseError>` — parse errors land in the typed error channel instead of throwing as defects. The handler can then `mapError` them into `ApiError`.

## Improved Error Mapping in Handlers (S7)

Every handler maps domain errors to `ApiError` for consistent HTTP error responses:

```typescript
.handle("create", ({ payload }) =>
  awsClient.createPullRequest({ ... }).pipe(
    Effect.mapError((e) => new ApiError({ message: e.message }))
  ))

.handle("search", ({ urlParams }) =>
  Effect.gen(function*() { ... }).pipe(
    Effect.mapError((e) => new ApiError({ message: String(e) }))
  ))
```

`ApiError` is an `HttpApiSchema.UnauthorizedError`-style schema error that the HttpApi framework automatically converts to the correct HTTP status code. `String(e)` handles both typed errors (with `.message`) and unknown errors.

## Gotchas

1. **CORS** — Configurable via `ALLOWED_ORIGINS` env var (comma-separated). Defaults to `localhost:3000`.
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

### AutoRefresh — Layer Sibling Sharing with Error Recovery

The auto-refresh daemon shares services with handlers via layer sibling merging:

```typescript
const refreshIteration = Effect.gen(function* () {
  const config = yield* configService.load.pipe(Effect.catchAll(() => Effect.succeed(defaults)))
  if (config.autoRefresh) {
    yield* Effect.sleep(Duration.seconds(config.refreshIntervalSeconds))
    yield* prService.refresh
  } else {
    yield* Effect.sleep(Duration.seconds(30))
  }
}).pipe(
  Effect.catchAllCause((cause) =>
    Effect.logError("Auto-refresh failed", cause).pipe(Effect.zipRight(Effect.sleep(Duration.seconds(10))))
  )
)

const AutoRefresh = Layer.effectDiscard(
  Effect.gen(function* () {
    const prService = yield* PRService.PRService
    const configService = yield* ConfigService.ConfigService
    yield* Effect.forkDaemon(
      prService.refresh.pipe(
        Effect.zipRight(Effect.logInfo("Initial PR refresh complete")),
        Effect.zipRight(Effect.forever(refreshIteration))
      )
    )
  })
)

// Merged alongside API handlers — both share AllServicesLive
const ApiLive = Layer.merge(
  HttpLayerRouter.addHttpApi(CodeCommitApi).pipe(Layer.provide(HandlersLive)),
  AutoRefresh
).pipe(Layer.provide(AllServicesLive))
```

If `AutoRefresh` had its own `Layer.provide(PRServiceLive_)`, it would create a
separate PRService instance — refreshing a state that no handler reads from.

## Further Reading

- [HttpApi](https://effect.website/docs/platform/http-api/)
- [HttpApiBuilder](https://effect.website/docs/platform/http-api-builder/)
- [SubscriptionRef](https://effect.website/docs/state-management/subscription-ref/)
