# `@knpkv/confluence-api-client`

Schema-validated Effect clients generated from Atlassian's Confluence Cloud REST API V1 and V2 OpenAPI documents.

## Usage

The service requires configuration and an Effect `HttpClient` implementation:

```ts
import { ConfluenceApiClient, ConfluenceApiConfig } from "@knpkv/confluence-api-client"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"

const program = Effect.gen(function* () {
  const confluence = yield* ConfluenceApiClient
  return yield* confluence.v2.getPageById("12345", {
    params: { "body-format": "atlas_doc_format" }
  })
})

const config = Layer.succeed(ConfluenceApiConfig, {
  baseUrl: "https://example.atlassian.net",
  auth: {
    type: "basic",
    email: "developer@example.com",
    apiToken: Redacted.make("api-token")
  }
})

program.pipe(
  Effect.provide(ConfluenceApiClient.layer),
  Effect.provide(config),
  Effect.provide(NodeHttpClient.layerFetch),
  Effect.runPromise
)
```

The root package exports `ConfluenceV1Api` and `ConfluenceV2Api` namespaces. The generated modules are also available through `@knpkv/confluence-api-client/generated/v1` and `/generated/v2`.

## Regenerating

Run from the workspace root:

```sh
pnpm --filter @knpkv/confluence-api-client regenerate
```

This command performs one reproducible pipeline for both API versions:

1. Fetch the current raw documents from Atlassian.
2. Store the unmodified documents as `.specs/confluence-v1.json` and `.specs/confluence-v2.json`.
3. Apply the committed RFC 6902 patches in memory.
4. Normalize OpenAPI-only nullable metadata and remove empty error responses
   that would otherwise be generated as successful `void` values.
5. Generate `src/generated/ConfluenceV1Api.ts` and `ConfluenceV2Api.ts` with `@effect/openapi-generator`.

To regenerate without network access from the committed documents:

```sh
pnpm --filter @knpkv/confluence-api-client regenerate --local
```

Generated files must not be edited manually. Change the upstream patch or generator script and regenerate instead.

## Why patches exist

The raw documents remain byte-for-byte representations of Atlassian's JSON data after canonical formatting. Compatibility fixes live separately:

- V1's recursive `Content` graph currently exceeds the Effect generator's circular-reference handling. It is represented as unknown; the attachment consumer validates the selected result with its domain Schema.
- V1's `Space.permissions` edge creates a generated forward reference and is unused by this package's operations.
- The attachment endpoint requires `X-Atlassian-Token` but omits the header parameter. Its multipart request is represented as unknown because native `FormData` cannot be expressed by that OpenAPI schema.
- Used V2 nullable position fields are expressed as explicit JSON Schema null
  unions. The generator resolves these OpenAPI `nullable` fields to
  `Schema.Never` before its `onEnter` hook runs, so the hook alone cannot repair
  them; the focused patch is required and covered by response-decoding tests.

Review patch changes particularly carefully: they are compatibility contracts, not copies of upstream data.

## Checking freshness

```sh
pnpm --filter @knpkv/confluence-api-client regenerate:check
```

The check fetches both complete documents and compares canonical JSON structures. It deliberately does not compare `info.version`: Atlassian keeps those values at `1.0.0` and `2.0.0` while changing the documents.

After regeneration, review and validate with:

```sh
git diff -- packages/confluence-api-client/.specs packages/confluence-api-client/src/generated
pnpm --filter @knpkv/confluence-api-client check
pnpm --filter @knpkv/confluence-api-client test
pnpm --filter @knpkv/confluence-api-client build
pnpm --filter @knpkv/confluence-to-markdown check
pnpm --filter @knpkv/confluence-to-markdown test
```

The scheduled `Confluence API Spec Check` workflow runs the same freshness check and opens or updates a tested regeneration pull request when either upstream document changes.
