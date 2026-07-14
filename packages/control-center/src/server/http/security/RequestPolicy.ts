import { Effect, Result, Schema, Stream } from "effect"

import { DEFAULT_HTTP_SECURITY_LIMITS, HttpByteLimit } from "./HttpLimits.js"

const ContentLength = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
)

const HeaderValue = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))

const RequestBodyMetadata = Schema.Struct({
  method: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(16)),
  contentEncoding: Schema.NullOr(HeaderValue),
  contentLength: Schema.NullOr(ContentLength),
  contentType: Schema.NullOr(HeaderValue),
  transferEncoding: Schema.NullOr(HeaderValue)
})

/** A request body failed the centralized transport and size policy. */
export class RequestBodyPolicyError extends Schema.TaggedErrorClass<RequestBodyPolicyError>()(
  "RequestBodyPolicyError",
  {
    reason: Schema.Literals([
      "invalid-metadata",
      "compressed-body-rejected",
      "conflicting-length-headers",
      "body-too-large",
      "safe-method-body-rejected",
      "content-type-required",
      "content-type-rejected"
    ]),
    maximumBytes: Schema.NullOr(HttpByteLimit)
  }
) {}

/** Inputs for evaluating request body metadata before any body accessor is used. */
export interface AuthorizeRequestBodyInput {
  readonly metadata: unknown
  readonly expectsJson: boolean
  readonly maximumBytes?: number | undefined
}

/** Trusted body policy returned after headers and declared length are accepted. */
export interface AuthorizedRequestBody {
  readonly declaredBytes: number | null
  readonly maximumBytes: HttpByteLimit
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

const isJsonContentType = (value: string): boolean => {
  const segments = value.toLowerCase().split(";").map((segment) => segment.trim())
  if (segments[0] !== "application/json") return false
  return segments.slice(1).every((segment) => segment === "charset=utf-8")
}

/** Authorize request headers and declared length before reading an API body. */
export const authorizeRequestBody = Effect.fn("RequestPolicy.authorizeRequestBody")(function*(
  input: AuthorizeRequestBodyInput
): Effect.fn.Return<AuthorizedRequestBody, RequestBodyPolicyError> {
  const metadata = yield* Schema.decodeUnknownEffect(RequestBodyMetadata)(input.metadata).pipe(
    Effect.mapError(() => new RequestBodyPolicyError({ reason: "invalid-metadata", maximumBytes: null }))
  )
  const maximumResult = Schema.decodeUnknownResult(HttpByteLimit)(
    input.maximumBytes ?? DEFAULT_HTTP_SECURITY_LIMITS.maximumRequestBytes
  )
  if (Result.isFailure(maximumResult)) {
    return yield* new RequestBodyPolicyError({ reason: "invalid-metadata", maximumBytes: null })
  }
  const maximumBytes = maximumResult.success
  const contentEncoding = metadata.contentEncoding?.toLowerCase() ?? "identity"
  if (contentEncoding !== "identity") {
    return yield* new RequestBodyPolicyError({ reason: "compressed-body-rejected", maximumBytes })
  }
  if (metadata.contentLength !== null && metadata.transferEncoding !== null) {
    return yield* new RequestBodyPolicyError({ reason: "conflicting-length-headers", maximumBytes })
  }
  if (metadata.contentLength !== null && metadata.contentLength > maximumBytes) {
    return yield* new RequestBodyPolicyError({ reason: "body-too-large", maximumBytes })
  }

  const method = metadata.method.toUpperCase()
  const hasDeclaredBody = (metadata.contentLength ?? 0) > 0 || metadata.transferEncoding !== null
  if (SAFE_METHODS.has(method) && hasDeclaredBody) {
    return yield* new RequestBodyPolicyError({ reason: "safe-method-body-rejected", maximumBytes })
  }
  if (input.expectsJson && hasDeclaredBody && metadata.contentType === null) {
    return yield* new RequestBodyPolicyError({ reason: "content-type-required", maximumBytes })
  }
  if (input.expectsJson && metadata.contentType !== null && !isJsonContentType(metadata.contentType)) {
    return yield* new RequestBodyPolicyError({ reason: "content-type-rejected", maximumBytes })
  }
  return { declaredBytes: metadata.contentLength, maximumBytes }
})

const countedChunk = (
  totalBytes: number,
  chunk: Uint8Array
): readonly [state: number, values: ReadonlyArray<Uint8Array>] => [totalBytes, [chunk]]

/** Count actual streamed bytes so chunked and dishonest-length bodies cannot bypass limits. */
export const limitRequestBodyStream = <Error, Requirements>(
  stream: Stream.Stream<Uint8Array, Error, Requirements>,
  maximumBytes: HttpByteLimit
): Stream.Stream<Uint8Array, Error | RequestBodyPolicyError, Requirements> =>
  stream.pipe(
    Stream.mapAccumEffect(
      () => 0,
      (totalBytes, chunk) => {
        const nextTotal = totalBytes + chunk.byteLength
        return nextTotal <= maximumBytes
          ? Effect.succeed(countedChunk(nextTotal, chunk))
          : Effect.fail(new RequestBodyPolicyError({ reason: "body-too-large", maximumBytes }))
      }
    )
  )
