/** Host-local Sandboxes reads: the redacted pool overview, nothing that writes. @module */
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { SandboxesOverview } from "@knpkv/sandbox-pool/host"
import { Effect, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"

/** The overview read failed before a pool payload arrived. */
export class SandboxesClientError extends Schema.TaggedError<SandboxesClientError>()("SandboxesClientError", {
  detail: Schema.Literals(["network", "status", "invalid_response", "timeout"])
}) {}

/** One overview read, bounded at 1 MiB and 30 seconds. */
export const loadSandboxesOverview = Effect.gen(function*() {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.get("/v1/modules/sandboxes/overview").pipe(
    Effect.mapError(() => new SandboxesClientError({ detail: "network" }))
  )
  if (response.status < 200 || response.status >= 300) return yield* new SandboxesClientError({ detail: "status" })
  return yield* decodeBoundedResponseJson(response, SandboxesOverview, 1_048_576).pipe(
    Effect.mapError(() => new SandboxesClientError({ detail: "invalid_response" }))
  )
}).pipe(
  Effect.timeout("30 seconds"),
  Effect.catchTag("TimeoutError", () => Effect.fail(new SandboxesClientError({ detail: "timeout" }))),
  Effect.withSpan("SandboxesClient.loadOverview")
)
