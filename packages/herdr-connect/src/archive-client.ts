/** One authorized canonical-listener archive page. Paging is explicit, never a background full-archive scan. */
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/http"
import { type ConnectArchiveCursor, ConnectArchivePage } from "./model.js"

export class ConnectArchiveLoadError extends Schema.TaggedError<ConnectArchiveLoadError>()("ConnectArchiveLoadError", {
  reason: Schema.Literals(["network", "status", "decode"]),
  cause: Schema.Defect()
}) {}

/** Fetch one bounded page, retaining the failure category for the caller's initial or inline retry. */
export const loadConnectArchive = Effect.fn("ConnectArchive.load")(function*(cursor: ConnectArchiveCursor | null) {
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
})
