/**
 * Host-local Sandboxes: the redacted pool overview, one account's runs, pending Fleet requests, the caller,
 * and the owner's lease, extend and release.
 * @module
 */
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { type SandboxCard, SandboxesOverview, SandboxRuns } from "@knpkv/sandbox-pool/host"
import { Effect, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import { SandboxesCaller, SandboxJobOrder, SandboxJobSubmitted, SandboxRequests } from "./sandboxes-contract.js"

/** The overview read failed before a pool payload arrived. */
export class SandboxesClientError extends Schema.TaggedError<SandboxesClientError>()("SandboxesClientError", {
  detail: Schema.Literals(["network", "status", "invalid_response", "timeout"])
}) {}

/**
 * A job was not submitted. `already_requested`, `not_quarantined` and `not_budget_held` are the hub's
 * reasons for refusing a retry or lift before it reached Fleet; any other refusal is `rejected`.
 */
export class SandboxesWriteFailed extends Schema.TaggedError<SandboxesWriteFailed>()("SandboxesWriteFailed", {
  reason: Schema.Literals([
    "rejected",
    "network",
    "unauthorized",
    "already_requested",
    "not_quarantined",
    "not_budget_held"
  ])
}) {}

const RefusedRequest = Schema.Struct({
  error: Schema.Literals(["already_requested", "not_quarantined", "not_budget_held"])
})

/** One GET of a module read, bounded in bytes and at 30 seconds. Any non-2xx answer is a status failure. */
const readJson = Effect.fn("SandboxesClient.readJson")(
  function*<A>(url: string, schema: Schema.Codec<A, unknown>, maxBytes: number) {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(url).pipe(
      Effect.mapError(() => new SandboxesClientError({ detail: "network" }))
    )
    if (response.status < 200 || response.status >= 300) return yield* new SandboxesClientError({ detail: "status" })
    return yield* decodeBoundedResponseJson(response, schema, maxBytes).pipe(
      Effect.mapError(() => new SandboxesClientError({ detail: "invalid_response" }))
    )
  },
  Effect.timeout("30 seconds"),
  Effect.catchTag("TimeoutError", () => Effect.fail(new SandboxesClientError({ detail: "timeout" })))
)

/** One overview read, bounded at 1 MiB and 30 seconds. */
export const loadSandboxesOverview = readJson("/v1/modules/sandboxes/overview", SandboxesOverview, 1_048_576).pipe(
  Effect.withSpan("SandboxesClient.loadOverview")
)

/** Who is reading the page, from the same authorization the module routes use. */
export const loadSandboxesCaller = readJson("/v1/modules/sandboxes/caller", SandboxesCaller, 4_096).pipe(
  Effect.withSpan("SandboxesClient.loadCaller")
)

/** The newest page of one account's runs. An account not in the pool is a status failure. */
export const loadSandboxRuns = (accountId: SandboxCard["accountId"]) =>
  readJson(`/v1/modules/sandboxes/runs?${new URLSearchParams({ id: accountId })}`, SandboxRuns, 1_048_576).pipe(
    Effect.withSpan("SandboxesClient.loadRuns")
  )

/** Resets and budget lifts waiting in Fleet / Approvals. */
export const loadSandboxRequests = readJson("/v1/modules/sandboxes/requests", SandboxRequests, 262_144).pipe(
  Effect.withSpan("SandboxesClient.loadRequests")
)

/**
 * Submits one job from this page. The browser sends its own origin; the hub accepts it only from its own node.
 * 403 is the owner rule, 409 a job the hub or Fleet refused, with the hub's reason when it names one;
 * anything else may or may not have reached Fleet.
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
  if (response.status === 409) {
    const refused = yield* decodeBoundedResponseJson(response, RefusedRequest, 4_096).pipe(
      Effect.map(({ error }) => error),
      // An unnamed or unreadable 409 is still a refusal: nothing was submitted.
      Effect.orElseSucceed((): SandboxesWriteFailed["reason"] => "rejected")
    )
    return yield* new SandboxesWriteFailed({ reason: refused })
  }
  if (response.status !== 202) return yield* new SandboxesWriteFailed({ reason: "network" })
  return yield* decodeBoundedResponseJson(response, SandboxJobSubmitted, 4_096).pipe(
    Effect.mapError(() => new SandboxesWriteFailed({ reason: "network" }))
  )
})
