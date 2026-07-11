# @knpkv/jira-api-client

Schema-validated Effect client for Jira Cloud REST API v3. Request parameters,
response codecs, operation errors, and the low-level client are generated from
Atlassian's official OpenAPI document with `@effect/openapi-generator`.

## Usage

```ts
import { JiraApiClient, JiraApiConfig } from "@knpkv/jira-api-client"
import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Layer, Redacted } from "effect"

const program = Effect.gen(function* () {
  const jira = yield* JiraApiClient
  return yield* jira.getIssue("PROJ-123", {
    params: { fields: ["summary", "status"] }
  })
})

const ConfigLive = Layer.succeed(JiraApiConfig, {
  baseUrl: "https://example.atlassian.net",
  auth: {
    type: "basic",
    email: "developer@example.com",
    apiToken: Redacted.make("api-token")
  }
})

Effect.runPromise(
  program.pipe(
    Effect.provide(JiraApiClient.layer),
    Effect.provide(ConfigLive),
    Effect.provide(NodeHttpClient.layerUndici)
  )
)
```

OAuth2 configuration uses an access token and cloud ID. Requests are routed
through `https://api.atlassian.com/ex/jira/{cloudId}` automatically.

The complete generated module is exported as `JiraApi`, and `make` constructs
the generated client from an existing Effect `HttpClient`. Application code
normally uses `JiraApiClient`, which also provides `uploadAttachment` for Jira's
multipart endpoint. The upstream schema describes that endpoint as Java server
objects rather than a native `FormData`, so multipart construction deliberately
lives in this single handwritten boundary.

All successful JSON bodies are decoded with generated Effect Schemas. Documented
4xx and 5xx statuses fail with generated tagged errors such as `GetIssue404`;
transport and malformed-body failures remain in the typed error channel.

## Regenerating the client

Requirements:

- dependencies installed with `pnpm install`;
- network access to Atlassian for a live regeneration;
- a clean enough worktree to review generated changes independently.

Run a live regeneration from the repository root:

```sh
pnpm --filter @knpkv/jira-api-client regenerate
```

The command performs this deterministic pipeline:

1. Fetch `https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json`.
2. Canonically encode the unmodified response as `.specs/jira-v3.json`.
3. Apply `.specs/jira-v3.patch.json` as RFC 6902 JSON Patch in memory.
4. Normalize contradictory defaults and mixed open-object schemas in memory.
5. Add permissive JSON schemas to documented bodyless error responses so they
   cannot be mistaken for successful `void` responses.
6. Generate `src/generated/JiraApi.ts` with `@effect/openapi-generator`.

Never edit the generated TypeScript or committed upstream specification by
hand. Put intentional upstream corrections in the JSON Patch, or change the
documented normalization in `scripts/regenerate.ts`.

For an offline, reproducible regeneration from the committed specification:

```sh
pnpm --filter @knpkv/jira-api-client regenerate --local
```

Review and validate a regeneration with:

```sh
git diff -- packages/jira-api-client/.specs
git diff -- packages/jira-api-client/src/generated/JiraApi.ts
pnpm --filter @knpkv/jira-api-client check
pnpm --filter @knpkv/jira-api-client build
pnpm --filter @knpkv/jira-api-client test
pnpm --filter @knpkv/jira-cli test
pnpm --filter @knpkv/jira-clockify test
```

## Checking specification freshness

```sh
pnpm --filter @knpkv/jira-api-client regenerate:check
```

This fetches the complete current document and compares its canonical JSON
structure with the committed raw specification. It does not rely only on
Atlassian's version string.

`.github/workflows/jira-api-update.yml` runs the check daily. When the upstream
document changes, CI regenerates the client, builds and tests this package and
its Jira consumers, adds a changeset, and opens or updates a pull request on
`chore/jira-api-spec-update`.

Generated source is excluded from handwritten-source lint rules, but remains
fully typechecked, built, and exercised through transport and decoding tests.
