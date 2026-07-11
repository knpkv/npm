# @knpkv/clockify-api-client

Schema-validated Effect client for Clockify's REST API. Request builders,
response codecs, operation types, and the raw client are generated from
Clockify's OpenAPI document by `@effect/openapi-generator`.

## Usage

```typescript
import { NodeHttpClient } from "@effect/platform-node"
import { ClockifyApiClient, ClockifyApiConfig } from "@knpkv/clockify-api-client"
import { Effect, Layer, Redacted } from "effect"

const program = Effect.gen(function* () {
  const clockify = yield* ClockifyApiClient
  const user = yield* clockify.getUser()
  const projects = yield* clockify.getProjects("workspace-id")

  return { projects, user }
})

const ConfigLive = Layer.succeed(ClockifyApiConfig, {
  apiKey: Redacted.make("your-clockify-api-key"),
  workspaceId: "workspace-id",
  userId: "user-id",
  baseUrl: "https://api.clockify.me/api"
})

const ClockifyLive = ClockifyApiClient.layer.pipe(Layer.provide(ConfigLive), Layer.provide(NodeHttpClient.layerFetch))

Effect.runPromise(program.pipe(Effect.provide(ClockifyLive)))
```

`ClockifyApiClient` exposes the timer application's domain conveniences. The
complete generated client is exported as `ClockifyApi`, and `make` constructs
it directly from any Effect `HttpClient`:

```typescript
import { ClockifyApi, make } from "@knpkv/clockify-api-client"

const raw: ClockifyApi.ClockifyApi = make(httpClient, {
  apiKey: Redacted.make("key"),
  baseUrl: "https://api.clockify.me/api"
})

const entries =
  yield *
  raw.getTimeEntries("workspace-id", "user-id", {
    params: { "in-progress": "true" }
  })
```

All successful response bodies are decoded with generated Effect Schemas.
Malformed success bodies fail with `SchemaError`; transport and non-success
HTTP responses fail with `HttpClientError`.

## Regenerating the client

Run from the repository root:

```bash
pnpm --filter @knpkv/clockify-api-client regenerate
pnpm --filter @knpkv/clockify-api-client build
pnpm --filter @knpkv/clockify-api-client test
```

`regenerate` performs the complete deterministic pipeline:

1. Fetch `https://docs.clockify.me/openapi.json`.
2. Parse and canonicalize it as JSON.
3. Save the unmodified upstream document to `.specs/clockify-v1.json`.
4. Apply `.specs/clockify-v1.patch.json` in memory as RFC 6902 JSON Patch.
5. Remove unreliable `examples` and `default` schema annotations. Clockify's
   document currently contains metadata whose values contradict its schemas.
6. Generate `src/generated/ClockifyApi.ts` with
   `@effect/openapi-generator`'s `httpclient` format.
7. Record the upstream version in `.specs/VERSION`.

Never edit `src/generated/ClockifyApi.ts` or the committed upstream spec by
hand. API corrections belong in `clockify-v1.patch.json`; generator behavior
belongs in `scripts/regenerate.ts`. After changing only the patch or generator,
regenerate without network access:

```bash
pnpm --filter @knpkv/clockify-api-client regenerate --local
```

Review every regeneration with:

```bash
git diff -- packages/clockify-api-client/.specs
git diff -- packages/clockify-api-client/src/generated/ClockifyApi.ts
pnpm --filter @knpkv/clockify-api-client build
pnpm --filter @knpkv/clockify-api-client test
pnpm --filter @knpkv/jira-clockify test
```

## Checking specification freshness

```bash
pnpm --filter @knpkv/clockify-api-client regenerate:check
```

The command fetches and canonicalizes the current upstream document, then
compares it byte-for-byte with the committed unmodified document. It exits
non-zero with the regeneration command when they differ.

The scheduled `Clockify API Spec Check` GitHub Actions workflow runs this check
daily. When the spec changes it regenerates the client, builds it, runs the
Clockify and jira-clockify tests, adds a changeset, and opens or updates the
`chore/clockify-api-spec-update` pull request.

## Generated-code policy

`src/generated/**` is excluded from handwritten-source lint rules. The official
Effect beta generator currently emits a small number of internal casts needed
by its generic transport implementation. Generated code is still compiled and
tested; only style/AST rules intended for maintained source are skipped.

## License

MIT
