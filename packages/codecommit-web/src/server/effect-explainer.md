# Effect Explainer: Server Module

HttpApi deep dive — declarative endpoints, middleware, CORS as layers.

## Module Map

```
server/
├── Api.ts          ← Endpoint declarations (schemas, routes)
├── Server.ts       ← Server composition (layers, static files, CORS)
└── handlers/
    ├── index.ts                       ← Barrel export
    ├── prs-live.ts                    ← PR list/refresh/create/search/comments/open
    ├── config-live.ts                 ← Config load/save/validate/reset
    ├── accounts-live.ts               ← Account listing
    ├── events-live.ts                 ← SSE stream
    ├── notifications-live.ts          ← Notifications + SSO login/logout
    ├── subscriptions-live.ts          ← PR subscription management
    └── persistent-notifications-live.ts ← Persistent notifications (DB-backed)
```

## Api.ts — The Contract

```typescript
class PrsGroup extends HttpApiGroup.make("prs")
  .add(HttpApiEndpoint.get("list", "/").addSuccess(Schema.Chunk(PullRequest)))
  .add(HttpApiEndpoint.post("refresh", "/refresh").addSuccess(Schema.String))
  .add(HttpApiEndpoint.get("search", "/search").setUrlParams(...).addSuccess(...).addError(ApiError))
  .add(HttpApiEndpoint.post("refreshSingle", "/:awsAccountId/:prId/refresh").setPath(...))
  .add(HttpApiEndpoint.post("create", "/").setPayload(...).addError(ApiError))
  .add(HttpApiEndpoint.post("open", "/open").setPayload(...).addError(ApiError))
  .add(HttpApiEndpoint.post("comments", "/comments").setPayload(...).addError(ApiError))
  .prefix("/api/prs")
{}
```

This is a **contract** — it declares:

- Endpoint names (`"list"`, `"refresh"`, `"create"`, etc.)
- HTTP methods (`get`, `post`)
- URL paths (`/api/prs/`, `/api/prs/refresh`, etc.)
- Request/response schemas and error types

The contract is separate from implementation. This separation enables:

- Client codegen from the API definition
- Type-safe handler registration (compiler ensures all endpoints are handled)
- API documentation generation

### Endpoint Groups

```
CodeCommitApi
├── PrsGroup                    /api/prs/*
│   ├── GET  /                  (list)
│   ├── POST /refresh           (refresh — forkDaemon)
│   ├── GET  /search?q=...      (search — FTS5)
│   ├── POST /:awsAccountId/:prId/refresh (refreshSingle)
│   ├── POST /                  (create)
│   ├── POST /open              (open via assume)
│   └── POST /comments          (comments)
├── EventsGroup                 /api/events/*
│   └── GET  /                  (SSE stream)
├── ConfigGroup                 /api/config/*
│   ├── GET  /                  (list)
│   ├── GET  /path              (config file path)
│   ├── GET  /validate          (config validation)
│   ├── POST /save              (save config)
│   └── POST /reset             (reset config)
├── AccountsGroup               /api/accounts
│   └── GET  /                  (list enabled)
├── NotificationsGroup          /api/notifications/*
│   ├── GET  /                  (list)
│   ├── POST /clear             (clear all)
│   ├── POST /sso-login         (SSO login)
│   └── POST /sso-logout        (SSO logout)
├── SubscriptionsGroup          /api/subscriptions/*
│   ├── POST /subscribe         (subscribe to PR)
│   ├── POST /unsubscribe       (unsubscribe)
│   └── GET  /                  (list subscriptions)
└── PersistentNotificationsGroup /api/notifications/persistent/*
    ├── GET  /                  (list)
    ├── GET  /count             (unread count)
    ├── POST /read              (mark read)
    └── POST /read-all          (mark all read)
```

## Server.ts — Composition

### Layer Stack

```
AllRoutes (Layer.orDie — remaining service construction errors)
│
├── ApiLive
│   ├── HttpLayerRouter.addHttpApi(CodeCommitApi)  ← registers the API
│   ├── HandlersLive (PrsLive, ConfigLive, etc.)   ← implements endpoints
│   ├── AutoRefresh                                ← daemon: initial + recurring refresh
│   └── AllServicesLive
│       ├── PRServiceLive_ → PRServiceDeps (AwsClient + ReposLive + Config + Notifications)
│       ├── ConfigLive_ → ConfigServiceLive + PlatformLive
│       └── AwsClientLive_ → FetchHttpClient + AwsClientConfig.Default
├── ReposLive (Layer.orDie — DB/migration errors)
│   ├── PullRequestRepo.Default, CommentRepo.Default, ...
├── StaticRouter                                   ← SPA file serving
├── CORS middleware (allowedOrigins: localhost only)
└── Platform (BunHttpServer, BunContext, idleTimeout: 0 for SSE)
```

`Layer.orDie` is scoped: `ReposLive.pipe(Layer.orDie)` for DB/migration errors specifically,
plus `AllRoutes` for remaining service construction errors.

### AutoRefresh — Daemon with Per-Iteration Error Recovery

```typescript
const refreshIteration = Effect.gen(function* () {
  // ...
}).pipe(
  Effect.catchAllCause((cause) =>
    Effect.logError("Auto-refresh failed", cause).pipe(Effect.zipRight(Effect.sleep(Duration.seconds(10))))
  )
)

yield *
  Effect.forkDaemon(
    prService.refresh.pipe(
      Effect.zipRight(Effect.logInfo("Initial PR refresh complete")),
      Effect.zipRight(Effect.forever(refreshIteration))
    )
  )
```

`catchAllCause` inside `Effect.forever` — each iteration recovers independently, loop never dies.

### Static File Middleware

The middleware intercepts requests before the API router:

```
Request arrives
    │
    ├── Path contains ".."? → reject (security)
    ├── File exists in clientDir? → serve with MIME type
    ├── Is API route (/api/*)? → pass to HttpApi router
    └── Default → serve index.html (SPA fallback)
```

MIME type mapping:

```typescript
const mimeTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png"
}
```

### CORS as Layer

```typescript
HttpLayerRouter.cors({
  allowedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
  allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
})
```

CORS is a Layer, not a middleware function. This means:

- It's composed declaratively with other layers
- It can be conditionally included (dev vs prod)
- It doesn't mutate request/response objects

## Handler Implementation Pattern

```typescript
// handlers/prs-live.ts — services resolved in Effect.gen scope, handlers chained
export const PrsLive = HttpApiBuilder.group(CodeCommitApi, "prs", (handlers) =>
  Effect.gen(function* () {
    const prService = yield* PRService.PRService
    const awsClient = yield* AwsClient.AwsClient

    return handlers
      .handle("list", () =>
        SubscriptionRef.get(prService.state).pipe(Effect.map((state) => Chunk.fromIterable(state.pullRequests)))
      )
      .handle("refresh", () =>
        prService.refresh.pipe(
          Effect.forkDaemon, // non-blocking — returns immediately
          Effect.map(() => "ok")
        )
      )
      .handle("search", ({ urlParams }) =>
        prService.searchPullRequests(urlParams.q).pipe(Effect.mapError((e) => new ApiError({ message: String(e) })))
      )
      .handle("create", ({ payload }) =>
        awsClient
          .createPullRequest({
            account: { profile: payload.account.profile, region: payload.account.region }
            // ...
          })
          .pipe(Effect.mapError((e) => new ApiError({ message: e.message })))
      )
    // + refreshSingle, comments, open handlers
  })
)
```

Key points:

- `HttpApiBuilder.group(api, "prs", ...)` — handler must match a group name from Api.ts
- `HttpApiBuilder.handle("list", ...)` — handler must match an endpoint name
- Compiler error if endpoint name is wrong or missing
- Handler receives typed request params (from Schema) and must return typed response

### Service Access in Handlers

Handlers access services through the R channel — no imports of singletons:

```typescript
HttpApiBuilder.handle("list", () =>
  Effect.gen(function* () {
    const prService = yield* PRService // from Layer
    const configService = yield* ConfigService // from Layer
    // ...
  })
)
```

## Testing Handlers

```typescript
// Provide mock services — test handler logic in isolation
const TestPRService = Layer.succeed(PRService, {
  state: mockSubscriptionRef,
  refresh: Effect.void
  // ...
})

const result = await Effect.runPromise(handler.pipe(Effect.provide(TestPRService)))
```

No HTTP server needed for unit tests — handlers are just Effects.

## Gotchas

1. **Handler names must match Api.ts** — `HttpApiBuilder.handle("lst", ...)` compiles but fails at runtime if the endpoint name is `"list"`. (TypeScript catches most of these.)
2. **Layer order** — Handler layers must be provided before service layers in the composition chain.
3. **Async FileSystem** — Server.ts now uses `@effect/platform FileSystem` (async, no sync node:fs).
4. **SSE content type** — SSE endpoints must set `Content-Type: text/event-stream`. With HttpApi, this needs explicit header configuration.

## Further Reading

- [HttpApi](https://effect.website/docs/platform/http-api/)
- [HttpApiGroup](https://effect.website/docs/platform/http-api/)
- [HttpApiBuilder](https://effect.website/docs/platform/http-api-builder/)
