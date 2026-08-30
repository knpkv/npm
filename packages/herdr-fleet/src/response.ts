import { Effect, Predicate, Schema, Stream } from "effect"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { FleetResponseBodyError } from "./errors.js"

export const fleetResponseBodyMaxBytes = 1024 * 1024

interface ResponseBodyState {
  readonly bytes: number
  readonly chunks: ReadonlyArray<Uint8Array>
}

const emptyResponseBody = (): ResponseBodyState => ({ bytes: 0, chunks: [] })

export const boundedResponseText = Effect.fn("FleetResponse.boundedText")(function*(
  response: HttpClientResponse.HttpClientResponse,
  maximumBytes = fleetResponseBodyMaxBytes
) {
  const collected = yield* response.stream.pipe(
    Stream.runFoldEffect(
      emptyResponseBody,
      (state, chunk) => {
        const bytes = state.bytes + chunk.byteLength
        return bytes > maximumBytes
          ? Effect.fail(
            new FleetResponseBodyError({
              cause: bytes,
              detail: `response body exceeded ${maximumBytes} bytes`,
              reason: "too_large"
            })
          )
          : Effect.succeed({ bytes, chunks: [...state.chunks, chunk] })
      }
    ),
    Effect.mapError((cause) =>
      Predicate.isTagged(cause, "FleetResponseBodyError")
        ? cause
        : new FleetResponseBodyError({
          cause,
          detail: String(cause),
          reason: "transport"
        })
    )
  )
  const body = new Uint8Array(collected.bytes)
  let offset = 0
  for (const chunk of collected.chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
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
