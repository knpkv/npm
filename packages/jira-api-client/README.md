# @knpkv/jira-api-client

Effect-based Jira Cloud REST API v3 client. Type-safe paths and responses generated from the official OpenAPI schema via `openapi-typescript` + `openapi-fetch`.

## Installation

```bash
pnpm add @knpkv/jira-api-client
```

Peer dependencies: `effect`

## Usage

```typescript
import { Effect, Layer } from "effect"
import * as Redacted from "effect/Redacted"
import { JiraApiClient, JiraApiConfig, toEffect } from "@knpkv/jira-api-client"

const program = Effect.gen(function* () {
  const client = yield* JiraApiClient

  // Get issue by key
  const issue = yield* toEffect(
    client.v3.client.GET("/rest/api/3/issue/{issueIdOrKey}", {
      params: { path: { issueIdOrKey: "PROJ-123" } }
    })
  )
  console.log(issue.fields?.summary)

  // Search with JQL
  const results = yield* toEffect(
    client.v3.client.POST("/rest/api/3/search/jql", {
      body: { jql: "project = PROJ AND status != Done", maxResults: 50 }
    })
  )
})

// Basic auth
const configLayer = Layer.succeed(JiraApiConfig, {
  baseUrl: "https://mysite.atlassian.net",
  auth: {
    type: "basic",
    email: "user@example.com",
    apiToken: Redacted.make("your-api-token")
  }
})

// Or OAuth2
const oauthConfigLayer = Layer.succeed(JiraApiConfig, {
  baseUrl: "",
  auth: {
    type: "oauth2",
    accessToken: Redacted.make("oauth-access-token"),
    cloudId: "your-cloud-id"
  }
})

Effect.runPromise(program.pipe(Effect.provide(JiraApiClient.layer), Effect.provide(configLayer)))
```

## API Pattern

All API calls go through `toEffect()` which wraps the openapi-fetch promise in an Effect:

```typescript
toEffect(client.v3.client.GET("/rest/api/3/..."))
// → Effect<ResponseData, FetchClientError>
```

Paths are fully type-safe — autocomplete and compile-time errors for invalid paths, params, and bodies.

## Errors

`FetchClientError` is a tagged error with `error`, `status`, and `message` fields:

```typescript
import { FetchClientError } from "@knpkv/jira-api-client"

program.pipe(Effect.catchTag("FetchClientError", (e) => Console.log(`HTTP ${e.status}: ${e.message}`)))
```

## Subpath Exports

| Export                                 | Contents                        |
| -------------------------------------- | ------------------------------- |
| `@knpkv/jira-api-client`               | Client, config, toEffect, types |
| `@knpkv/jira-api-client/v3`            | Generated V3 OpenAPI types      |
| `@knpkv/jira-api-client/JiraApiClient` | Client service only             |
| `@knpkv/jira-api-client/JiraApiConfig` | Config service only             |

## License

MIT
