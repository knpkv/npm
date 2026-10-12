/** One authorized archive page, requested explicitly or while restoring a URL-selected retained closure. */
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/http"
import { connectReadDeadline, ConnectTimeoutError } from "./internal/read-deadline.js"
import { type ConnectArchiveCursor, ConnectArchivePage } from "./model.js"

export class ConnectArchiveLoadError extends Schema.TaggedError<ConnectArchiveLoadError>()("ConnectArchiveLoadError", {
  reason: Schema.Literals(["network", "status", "decode"]),
  cause: Schema.Defect()
}) {}

/** Fetch and decode one bounded page within ten seconds, retaining typed failures for initial or inline retry. */
export const loadConnectArchive = Effect.fn("ConnectArchive.load")(
  function*(cursor: ConnectArchiveCursor | null) {
    const client = yield* HttpClient.HttpClient
    const path = cursor === null
      ? "/v1/connect/archive"
      : `/v1/connect/archive?cursor=${encodeURIComponent(JSON.stringify(cursor))}`
    const response = yield* client.get(path).pipe(
      Effect.mapError((cause) => new ConnectArchiveLoadError({ reason: "network", cause }))
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* new ConnectArchiveLoadError({ reason: "status", cause: response.status })
    }
    return yield* decodeBoundedResponseJson(response, ConnectArchivePage).pipe(
      Effect.mapError((cause) => new ConnectArchiveLoadError({ reason: "decode", cause }))
    )
  },
  Effect.timeout(connectReadDeadline),
  Effect.catchTag("TimeoutError", () => Effect.fail(new ConnectTimeoutError()))
)
