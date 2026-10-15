import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/http"
import { HostResources } from "./host-resources-model.js"

export class ResourcesReadFailed extends Schema.TaggedError<ResourcesReadFailed>()("ResourcesReadFailed", {
  reason: Schema.Literals(["network", "status", "invalid_response", "timeout"])
}) {}

/** Reads this host only; the shared runtime owns cancellation and authentication. */
export const loadHostResources = Effect.fn("ResourcesClient.load")(
  function*() {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get("/v1/host/resources").pipe(
      Effect.mapError(() => new ResourcesReadFailed({ reason: "network" }))
    )
    if (response.status !== 200) return yield* new ResourcesReadFailed({ reason: "status" })
    return yield* decodeBoundedResponseJson(response, HostResources, 4 * 1024 * 1024).pipe(
      Effect.mapError(() => new ResourcesReadFailed({ reason: "invalid_response" }))
    )
  },
  Effect.timeout("15 seconds"),
  Effect.catchTag("TimeoutError", () => Effect.fail(new ResourcesReadFailed({ reason: "timeout" })))
)
