import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { SafeMediaContentType } from "../../api/media.js"
import { ApplicationResourceNotFound, ApplicationServiceUnavailable, MediaReads } from "../api/ApplicationServices.js"
import { DEFAULT_HTTP_SECURITY_LIMITS } from "../http/security/HttpLimits.js"
import { BlobDigest } from "../persistence/object-store/BlobDigest.js"
import { Persistence } from "../persistence/Persistence.js"
import { mapPersistenceReadError } from "./errors.js"

const notFound = (): ApplicationResourceNotFound => new ApplicationResourceNotFound()
const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

/** Construct an opaque, workspace-authorized media reader over content-addressed storage. */
export const makeMediaReads = Effect.gen(function*() {
  const persistence = yield* Persistence

  return MediaReads.of({
    read: Effect.fn("MediaReads.read")(function*({ mediaId, workspaceId }) {
      const digest = yield* Schema.decodeUnknownEffect(BlobDigest)(mediaId.slice("media_".length)).pipe(
        Effect.mapError(() => notFound())
      )
      const metadata = yield* persistence.content.getMetadata(workspaceId, digest).pipe(
        Effect.mapError(mapPersistenceReadError)
      )
      if (metadata.mimeType === null || metadata.byteLength > DEFAULT_HTTP_SECURITY_LIMITS.maximumMediaSourceBytes) {
        return yield* notFound()
      }
      const contentType = yield* Schema.decodeUnknownEffect(SafeMediaContentType)(metadata.mimeType).pipe(
        Effect.mapError(() => notFound())
      )
      const bytes = yield* persistence.content.readAll(
        workspaceId,
        digest,
        DEFAULT_HTTP_SECURITY_LIMITS.maximumMediaSourceBytes
      ).pipe(
        Effect.mapError(mapPersistenceReadError)
      )
      if (bytes.byteLength !== metadata.byteLength) return yield* unavailable()
      return {
        body: Stream.make(bytes),
        contentLength: metadata.byteLength,
        contentType
      }
    })
  })
})

/** Live opaque media layer. */
export const mediaReadsLayer = Layer.effect(MediaReads, makeMediaReads)
