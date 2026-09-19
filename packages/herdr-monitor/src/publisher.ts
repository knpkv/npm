import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Redacted, Schema } from "effect"
import { HttpBody, HttpClient } from "effect/unstable/http"
import { decodeSnapshot, MAX_BYTES, Snapshot } from "./model.js"

export class PublishRejected
  extends Schema.TaggedError<PublishRejected>()("PublishRejected", { status: Schema.Number })
{}
export class PublishFailed extends Schema.TaggedError<PublishFailed>()("PublishFailed", {}) {}
const Destination = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$|^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/)
)

/** Sends a caller-sanitized snapshot once. No redirects, retries, response body or response instructions. */
export const publish = Effect.fn("Monitor.publish")(
  function*(origin: string, token: Redacted.Redacted<string>, input: Snapshot) {
    const destination = yield* Schema.decodeUnknownEffect(Destination)(origin)
    const credential = Redacted.value(token)
    if (!/^publish_[A-Za-z0-9_-]{43}$/.test(credential)) return yield* new PublishFailed()
    const snapshot = yield* decodeSnapshot(input)
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Snapshot))(snapshot)
    if (new TextEncoder().encode(body).byteLength > MAX_BYTES) return yield* new PublishFailed()
    const client = yield* HttpClient.HttpClient
    const response = yield* HttpClient.withScope(client).put(`${destination}/boards/${snapshot.boardId}`, {
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: HttpBody.text(body, "application/json")
    })
    if (response.status !== 204) return yield* new PublishRejected({ status: response.status })
  },
  Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
  Effect.timeout("5 seconds"),
  Effect.catchTag(["SchemaError", "HttpClientError", "TimeoutError"], () => Effect.fail(new PublishFailed())),
  // Publication is a callable entry point with its own scoped transport, never an inherited session client.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(NodeHttpClient.layerNodeHttp),
  Effect.scoped
)
