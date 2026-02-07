# Effect Explainer: Server Module

HttpApi deep dive — declarative endpoints, middleware, CORS as layers.

## Module Map

```
server/
├── Api.ts          ← Endpoint declarations (schemas, routes)
├── Server.ts       ← Server composition (layers, static files, CORS)
└── handlers/
    ├── index.ts    ← Barrel export
    ├── prs-live.ts      ← PR list/refresh/create
    ├── config-live.ts   ← Config loading
    ├── accounts-live.ts ← Account listing
    └── events-live.ts   ← SSE stream
```

## Api.ts — The Contract

```typescript
class PrsGroup extends HttpApiGroup.make("prs").pipe(
  HttpApiGroup.add(HttpApiEndpoint.get("list", "/list")),
  HttpApiGroup.add(HttpApiEndpoint.post("refresh", "/refresh")),
  HttpApiGroup.add(HttpApiEndpoint.post("create", "/create")),
  HttpApiGroup.prefix("/api/prs")
) {}
```

This is a **contract** — it declares:

- Endpoint names (`"list"`, `"refresh"`, `"create"`)
- HTTP methods (`get`, `post`)
- URL paths (`/api/prs/list`)
- (Future) Request/response schemas, error types

The contract is separate from implementation. This separation enables:

- Client codegen from the API definition
- Type-safe handler registration (compiler ensures all endpoints are handled)
- API documentation generation

### Endpoint Groups

```
CodeCommitApi
├── PrsGroup      /api/prs/*
│   ├── GET  /list
│   ├── POST /refresh
│   └── POST /create
├── EventsGroup   /api/events/*
│   └── GET  /stream
├── ConfigGroup   /api/config
│   └── GET  /
└── AccountsGroup /api/accounts
    └── GET  /
```

## Server.ts — Composition

### Layer Stack

```
AllRoutes
│
├── ApiLive
│   ├── HttpLayerRouter.addHttpApi(CodeCommitApi)  ← registers the API
│   ├── HandlersLive (PrsLive, ConfigLive, etc.)   ← implements endpoints
│   └── AllServicesLive
│       ├── PRServiceLive_ → AwsClientLive + AwsClientConfig.Default + ConfigServiceLive + ...
│       ├── ConfigLive_ → ConfigServiceLive + PlatformLive
│       └── AwsClientLive_ → FetchHttpClient + AwsClientConfig.Default
├── StaticRouter                                   ← SPA file serving
├── CORS middleware
└── Platform (BunHttpServer, BunContext)
```

Note: `AwsClientConfig.Default` is required in the layer stack wherever `AwsClientLive`
is used. It provides AWS SDK configuration (credentials, retry settings).

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
HttpApiBuilder.middlewareCors({ allowOrigin: "*" })
```

CORS is a Layer, not a middleware function. This means:

- It's composed declaratively with other layers
- It can be conditionally included (dev vs prod)
- It doesn't mutate request/response objects

## Handler Implementation Pattern

```typescript
// handlers/prs-live.ts — services resolved in Effect.gen scope, handlers chained
export const PrsLive = HttpApiBuilder.group(CodeCommitApi, "prs", (handlers) =>
  Effect.gen(function*() {
    const prService = yield* PRService.PRService
    const awsClient = yield* AwsClient.AwsClient
    const httpClient = yield* HttpClient.HttpClient

    return handlers
      .handle("list", () =>
        SubscriptionRef.get(prService.state).pipe(
          Effect.map((state) => Chunk.fromIterable(state.pullRequests))
        ))
      .handle("refresh", () =>
        prService.refresh.pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.map(() => "ok")
        ))
      .handle("create", ({ payload }) =>
        awsClient.createPullRequest({ ... }).pipe(
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
  }))
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
