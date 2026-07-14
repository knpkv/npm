import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

import {
  CorrelationId,
  ForbiddenApiError,
  NotFoundApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError,
  UnauthorizedApiError
} from "./errors.js"
import { SessionCookieAuth } from "./session.js"

/** Workspace-scoped opaque media reference that reveals neither provider URLs nor local storage keys. */
export const OpaqueMediaId = Schema.String.check(
  Schema.isPattern(/^media_[0-9a-f]{64}$/u, { expected: "an opaque SHA-256 media identifier" })
).pipe(Schema.brand("OpaqueMediaId"))

/** Decoded opaque media identifier. */
export type OpaqueMediaId = typeof OpaqueMediaId.Type

/** Closed set of inert raster formats accepted at the authenticated media boundary. */
export const SafeMediaContentType = Schema.Literals([
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/webp"
])

/** Decoded safe raster media content type. */
export type SafeMediaContentType = typeof SafeMediaContentType.Type

/** Security and metadata headers required on authenticated opaque media responses. */
export const MediaResponseHeaders = Schema.Struct({
  "x-correlation-id": CorrelationId,
  "content-type": SafeMediaContentType,
  "content-length": Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  "cache-control": Schema.Literal("private, no-store"),
  "x-content-type-options": Schema.Literal("nosniff")
}).annotate({ identifier: "MediaResponseHeaders" })

/** Decoded opaque media response headers. */
export type MediaResponseHeaders = typeof MediaResponseHeaders.Type

const read = HttpApiEndpoint.get("read", "/:mediaId", {
  params: Schema.Struct({ mediaId: OpaqueMediaId }),
  success: HttpApiSchema.StreamUint8Array({ contentType: "application/octet-stream" }),
  error: [
    UnauthorizedApiError,
    ForbiddenApiError,
    NotFoundApiError,
    RequestTimedOutApiError,
    ServiceUnavailableApiError
  ]
}).middleware(SessionCookieAuth)

/** Authenticated, workspace-resolved opaque media contract. */
export class MediaApiGroup extends HttpApiGroup.make("media").add(read).prefix("/api/v1/media") {}
