import { collectBoundedText } from "@knpkv/bounded-io"
import { Effect, Predicate, Schema } from "effect"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import { FleetResponseBodyError } from "./errors.js"
import { fleetResponseBodyMaxBytes } from "./limits.js"

export { fleetResponseBodyMaxBytes } from "./limits.js"

export const boundedResponseText = Effect.fn("FleetResponse.boundedText")(function*(
  response: HttpClientResponse.HttpClientResponse,
  maximumBytes = fleetResponseBodyMaxBytes
) {
  return yield* collectBoundedText(response.stream, maximumBytes).pipe(
    Effect.mapError((cause) =>
      Predicate.isTagged(cause, "ByteLimitExceeded")
        ? new FleetResponseBodyError({
          cause: cause.observedBytes,
          detail: `response body exceeded ${maximumBytes} bytes`,
          reason: "too_large"
        })
        : new FleetResponseBodyError({
          cause,
          detail: String(cause),
          reason: "transport"
        })
    )
  )
})

export const decodeBoundedResponseJson = Effect.fn("FleetResponse.decodeJson")(function*<A>(
  response: HttpClientResponse.HttpClientResponse,
  schema: Schema.Codec<A, unknown, never, never>,
  maximumBytes = fleetResponseBodyMaxBytes
) {
  const text = yield* boundedResponseText(response, maximumBytes)
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(
      (cause) =>
        new FleetResponseBodyError({
          cause,
          detail: String(cause),
          reason: "decode"
        })
    )
  )
})
