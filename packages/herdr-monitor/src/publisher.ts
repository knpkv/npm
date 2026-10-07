import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Redacted, Schema } from "effect"
import { HttpBody, HttpClient } from "effect/http"
import { decodeSnapshot, MAX_BYTES, Snapshot } from "./model.js"

/** The monitor answered with something other than 204; `status` says why (401 key, 409 sequence, 429 rate). */
export class PublishRejected
  extends Schema.TaggedError<PublishRejected>()("PublishRejected", { origin: Schema.String, status: Schema.Number })
{}
/** The origin is not `https://host[:port]` or `http://127.0.0.1:port`. Origins are not secret. */
export class InvalidOrigin extends Schema.TaggedError<InvalidOrigin>()("InvalidOrigin", { origin: Schema.String }) {}
/** The publish key is not `publish_` and 43 base64url characters. Carries nothing of the key. */
export class InvalidPublishToken extends Schema.TaggedError<InvalidPublishToken>()("InvalidPublishToken", {}) {}
/** The encoded snapshot is over `MAX_BYTES`. */
export class SnapshotTooLarge
  extends Schema.TaggedError<SnapshotTooLarge>()("SnapshotTooLarge", { bytes: Schema.Number })
{}
/** The snapshot does not match the published contract; `reason` is the schema's description. */
export class InvalidSnapshot
  extends Schema.TaggedError<InvalidSnapshot>()("InvalidSnapshot", { reason: Schema.String })
{}
/** No answer could be read from the monitor at `origin`. */
export class MonitorUnreachable extends Schema.TaggedError<MonitorUnreachable>()("MonitorUnreachable", {
  origin: Schema.String,
  reason: Schema.String
}) {}
/** The monitor did not answer within five seconds. */
export class PublishTimedOut
  extends Schema.TaggedError<PublishTimedOut>()("PublishTimedOut", { origin: Schema.String })
{}

/** Every way a publication can fail, each naming the input to fix. */
export type PublishError =
  | InvalidOrigin
  | InvalidPublishToken
  | InvalidSnapshot
  | MonitorUnreachable
  | PublishRejected
  | PublishTimedOut
  | SnapshotTooLarge
const Destination = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$|^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/)
)

/** Sends a caller-sanitized snapshot once. No redirects, retries, response body or response instructions. */
export const publish = Effect.fn("Monitor.publish")(
  function*(origin: string, token: Redacted.Redacted<string>, input: Snapshot) {
    const destination = yield* Schema.decodeUnknownEffect(Destination)(origin).pipe(
      Effect.mapError(() => new InvalidOrigin({ origin }))
    )
    const credential = Redacted.value(token)
    if (!/^publish_[A-Za-z0-9_-]{43}$/.test(credential)) return yield* new InvalidPublishToken()
    const snapshot = yield* decodeSnapshot(input).pipe(
      Effect.mapError((error) => new InvalidSnapshot({ reason: error.message }))
    )
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Snapshot))(snapshot).pipe(
      Effect.mapError((error) => new InvalidSnapshot({ reason: error.message }))
    )
    const bytes = new TextEncoder().encode(body).byteLength
    if (bytes > MAX_BYTES) return yield* new SnapshotTooLarge({ bytes })
    const client = yield* HttpClient.HttpClient
    const response = yield* HttpClient.withScope(client).put(`${destination}/boards/${snapshot.boardId}`, {
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: HttpBody.text(body, "application/json")
    }).pipe(
      // The transport's own description: method, URL and cause. The key travels in a header it never prints.
      Effect.mapError((error) => new MonitorUnreachable({ origin: destination, reason: error.message })),
      Effect.timeout("5 seconds"),
      Effect.catchTag("TimeoutError", () => Effect.fail(new PublishTimedOut({ origin: destination })))
    )
    if (response.status !== 204) return yield* new PublishRejected({ origin: destination, status: response.status })
  },
  Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
  // Publication is a callable entry point with its own scoped transport, never an inherited session client.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(NodeHttpClient.layerNodeHttp),
  Effect.scoped
)
