import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { BlockedPushSettings, StageHeartbeat } from "./blocked-push-model.js"

export class BlockedNotificationClientError
  extends Schema.TaggedError<BlockedNotificationClientError>()("BlockedNotificationClientError", {
    operation: Schema.String,
    cause: Schema.Defect()
  })
{}
const failed = (operation: string) => (cause: unknown) => new BlockedNotificationClientError({ operation, cause })

const requestSettings = Effect.fn("BlockedNotificationClient.settings")(function*(settings?: BlockedPushSettings) {
  const client = yield* HttpClient.HttpClient
  const request = settings === undefined
    ? HttpClientRequest.get("/v1/push/blocked-settings")
    : yield* HttpClientRequest.put("/v1/push/blocked-settings").pipe(
      HttpClientRequest.bodyJson(settings),
      Effect.mapError(failed("settings.encode"))
    )
  const response = yield* client.execute(request).pipe(Effect.mapError(failed("settings.request")))
  if (response.status < 200 || response.status >= 300) {
    return yield* new BlockedNotificationClientError({ operation: "settings.status", cause: response.status })
  }
  return yield* decodeBoundedResponseJson(response, BlockedPushSettings).pipe(
    Effect.mapError(failed("settings.decode"))
  )
})
export const loadBlockedSettings = requestSettings()
export const saveBlockedSettings = (settings: BlockedPushSettings) => requestSettings(settings)

export const reportStageHeartbeat = Effect.fn("BlockedNotificationClient.heartbeat")(function*(input: StageHeartbeat) {
  const body = yield* Schema.decodeUnknownEffect(StageHeartbeat)(input).pipe(
    Effect.mapError(failed("heartbeat.encode"))
  )
  const client = yield* HttpClient.HttpClient
  const request = yield* HttpClientRequest.post("/v1/push/stage-heartbeat").pipe(
    HttpClientRequest.bodyJson(body),
    Effect.mapError(failed("heartbeat.encode"))
  )
  const response = yield* client.execute(request).pipe(Effect.mapError(failed("heartbeat.request")))
  if (response.status < 200 || response.status >= 300) {
    return yield* new BlockedNotificationClientError({ operation: "heartbeat.status", cause: response.status })
  }
})
