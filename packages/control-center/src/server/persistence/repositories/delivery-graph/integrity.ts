import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"

import type { WorkspaceId } from "../../../../domain/identifiers.js"
import { PersistenceOperationError } from "../../errors.js"
import { ContentBlobDigest } from "../models.js"
import { graphRecordError } from "./rows.js"

export const makeDeliveryGraphIntegrity = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto

  const digestText = Effect.fn("DeliveryGraphRepository.digestText")(function*(value: string) {
    const bytes = yield* Effect.fromResult(
      Encoding.decodeBase64(Encoding.encodeBase64(value))
    ).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "delivery-graph.encode" }))
    )
    const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "delivery-graph.digest" }))
    )
    return ContentBlobDigest.make(Encoding.encodeHex(digest))
  })

  const verifyDigest = Effect.fn("DeliveryGraphRepository.verifyDigest")(function*(options: {
    readonly workspaceId: WorkspaceId
    readonly recordKind: string
    readonly recordKey: string
    readonly json: string
    readonly expected: ContentBlobDigest
  }) {
    const actual = yield* digestText(options.json)
    if (actual !== options.expected) {
      return yield* graphRecordError(
        options.workspaceId,
        options.recordKind,
        options.recordKey,
        "delivery-graph-digest-mismatch"
      )
    }
  })

  return { digestText, verifyDigest }
})
