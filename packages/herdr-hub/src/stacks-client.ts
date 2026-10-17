/** Host-local Stacks reads: no peer address, provider locator or mutation request. @module */
import { StackDetailResult, type StackId, StackPlanResult, StacksOverviewResult } from "@knpkv/alchemy-console/host"
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { Effect, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"

export class StacksReadFailed extends Schema.TaggedError<StacksReadFailed>()("StacksReadFailed", {
  reason: Schema.Literals(["not_found", "unauthorized", "network", "status", "invalid_response", "timeout"])
}) {}

/** What the Stacks pages read; the shell supplies the live implementation, tests a fake. */
export interface StacksModuleReads {
  readonly overview: Effect.Effect<StacksOverviewResult, StacksReadFailed>
  readonly stack: (id: StackId) => Effect.Effect<StackDetailResult, StacksReadFailed>
  readonly plan: (id: StackId) => Effect.Effect<StackPlanResult, StacksReadFailed>
}

const load = Effect.fn("StacksClient.load")(
  function*<A>(path: string, schema: Schema.Codec<A, unknown, never, never>, maxBytes: number) {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(`/v1/modules/stacks/${path}`).pipe(
      Effect.mapError(() => new StacksReadFailed({ reason: "network" }))
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* new StacksReadFailed({
        reason: response.status === 404 ? "not_found" : response.status === 401 ? "unauthorized" : "status"
      })
    }
    return yield* decodeBoundedResponseJson(response, schema, maxBytes).pipe(
      Effect.mapError(() => new StacksReadFailed({ reason: "invalid_response" }))
    )
  },
  Effect.timeout("30 seconds"),
  Effect.catchTag("TimeoutError", () => Effect.fail(new StacksReadFailed({ reason: "timeout" })))
)

export const loadStacksOverview = load("overview", StacksOverviewResult, 1_048_576)
export const loadStack = (id: StackId) => load(`stack?${new URLSearchParams({ id })}`, StackDetailResult, 4_194_304)
export const loadStackPlan = (id: StackId) => load(`plan?${new URLSearchParams({ id })}`, StackPlanResult, 262_144)
