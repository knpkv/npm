# @knpkv/clockify-api-client

Effect-based Clockify REST API client. Type-safe paths and responses generated from a patched OpenAPI spec via `openapi-typescript` + `openapi-fetch`.

## Installation

```bash
pnpm add @knpkv/clockify-api-client
```

Peer dependencies: `effect`

## Usage

### Method-based API

Convenience methods for common operations:

```typescript
import { Effect, Layer } from "effect"
import * as Redacted from "effect/Redacted"
import { ClockifyApiClient, ClockifyApiConfig } from "@knpkv/clockify-api-client"

const program = Effect.gen(function* () {
  const clockify = yield* ClockifyApiClient

  const user = yield* clockify.getUser()
  const projects = yield* clockify.getProjects("workspace-id")

  // Start a timer
  const entry = yield* clockify.createTimeEntry("workspace-id", {
    start: new Date().toISOString(),
    description: "Working on PROJ-123"
  })

  // Stop timer
  yield* clockify.stopTimer("workspace-id", user.id, {
    end: new Date().toISOString()
  })

  // Get running timer
  const running = yield* clockify.getRunningTimer("workspace-id", user.id)
})

const configLayer = Layer.succeed(ClockifyApiConfig, {
  apiKey: Redacted.make("your-clockify-api-key"),
  workspaceId: "workspace-id",
  userId: "user-id",
  baseUrl: "https://api.clockify.me/api"
})

Effect.runPromise(program.pipe(Effect.provide(ClockifyApiClient.layer), Effect.provide(configLayer)))
```

### Raw API

Direct openapi-fetch access for any endpoint:

```typescript
import { toEffect } from "@knpkv/clockify-api-client"

const program = Effect.gen(function* () {
  const clockify = yield* ClockifyApiClient

  const user = yield* toEffect(clockify.api.client.GET("/v1/user"))

  const entries = yield* toEffect(
    clockify.api.client.GET("/v1/workspaces/{workspaceId}/user/{userId}/time-entries", {
      params: { path: { workspaceId: "ws-id", userId: "u-id" } }
    })
  )
})
```

## Available Methods

| Method                                   | Description                   |
| ---------------------------------------- | ----------------------------- |
| `getUser()`                              | Current authenticated user    |
| `getWorkspaces()`                        | List workspaces               |
| `getProjects(wsId)`                      | List projects in workspace    |
| `getProjectByName(wsId, name)`           | Find project by name          |
| `createTimeEntry(wsId, params)`          | Start or create entry         |
| `stopTimer(wsId, userId, params)`        | Stop running timer            |
| `getTimeEntries(wsId, userId, params?)`  | List time entries             |
| `getRunningTimer(wsId, userId)`          | Get in-progress entry or null |
| `getTimeEntry(wsId, entryId)`            | Get single entry              |
| `updateTimeEntry(wsId, entryId, params)` | Update entry                  |
| `deleteTimeEntry(wsId, entryId)`         | Delete entry                  |
| `getTags(wsId)`                          | List tags                     |
| `createTag(wsId, name)`                  | Create tag                    |
| `findOrCreateTag(wsId, name)`            | Find or create tag            |

## Errors

`FetchClientError` — tagged error with `status` and `message`:

```typescript
import { FetchClientError } from "@knpkv/clockify-api-client"

program.pipe(Effect.catchTag("FetchClientError", (e) => Console.log(`HTTP ${e.status}: ${e.message}`)))
```

## Notes

- The OpenAPI spec is patched for accurate types (the official spec has gaps).
- API key is stored as `Redacted<string>` to prevent accidental logging.

## Subpath Exports

| Export                                         | Contents                        |
| ---------------------------------------------- | ------------------------------- |
| `@knpkv/clockify-api-client`                   | Client, config, toEffect, types |
| `@knpkv/clockify-api-client/generated`         | Generated OpenAPI types         |
| `@knpkv/clockify-api-client/ClockifyApiClient` | Client service only             |
| `@knpkv/clockify-api-client/ClockifyApiConfig` | Config service only             |
| `@knpkv/clockify-api-client/ClockifyApiError`  | Error types                     |

## License

MIT
