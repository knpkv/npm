/** Host-local Sandboxes: the redacted pool overview, the caller, and the owner's lease, extend and release. @module */
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { SandboxesOverview } from "@knpkv/sandbox-pool/host"
import { Effect, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { SandboxesCaller, SandboxJobOrder, SandboxJobSubmitted } from "./sandboxes-contract.js"

/** The overview read failed before a pool payload arrived. */
export class SandboxesClientError extends Schema.TaggedError<SandboxesClientError>()("SandboxesClientError", {
  detail: Schema.Literals(["network", "status", "invalid_response", "timeout"])
}) {}

/** A lease, extend or release job was not submitted. */
export class SandboxesWriteFailed extends Schema.TaggedError<SandboxesWriteFailed>()("SandboxesWriteFailed", {
  reason: Schema.Literals(["rejected", "network", "unauthorized"])
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

/** Who is reading the page, from the same authorization the module routes use. */
export const loadSandboxesCaller = Effect.gen(function*() {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.get("/v1/modules/sandboxes/caller").pipe(
    Effect.mapError(() => new SandboxesClientError({ detail: "network" }))
  )
  if (response.status < 200 || response.status >= 300) return yield* new SandboxesClientError({ detail: "status" })
  return yield* decodeBoundedResponseJson(response, SandboxesCaller, 4_096).pipe(
    Effect.mapError(() => new SandboxesClientError({ detail: "invalid_response" }))
  )
}).pipe(
  Effect.timeout("30 seconds"),
  Effect.catchTag("TimeoutError", () => Effect.fail(new SandboxesClientError({ detail: "timeout" }))),
  Effect.withSpan("SandboxesClient.loadCaller")
)

/**
 * Submits one job from this page. The browser sends its own origin; the hub accepts it only from its own node.
 * 403 is the owner rule, 409 a job Fleet refused, anything else may or may not have reached Fleet.
 */
export const submitSandboxJob = Effect.fn("SandboxesClient.submitJob")(function*(order: SandboxJobOrder) {
  const client = yield* HttpClient.HttpClient
  const request = yield* HttpClientRequest.post("/v1/modules/sandboxes/jobs").pipe(
    HttpClientRequest.schemaBodyJson(SandboxJobOrder)(order),
    Effect.mapError(() => new SandboxesWriteFailed({ reason: "rejected" }))
  )
  const response = yield* client.execute(request).pipe(
    Effect.mapError(() => new SandboxesWriteFailed({ reason: "network" }))
  )
  if (response.status === 403) return yield* new SandboxesWriteFailed({ reason: "unauthorized" })
  if (response.status !== 202) {
    return yield* new SandboxesWriteFailed({ reason: response.status === 409 ? "rejected" : "network" })
  }
  return yield* decodeBoundedResponseJson(response, SandboxJobSubmitted, 4_096).pipe(
    Effect.mapError(() => new SandboxesWriteFailed({ reason: "network" }))
  )
})
