import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"

import type { WorkspaceId } from "../../../domain/identifiers.js"
import type { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { PersistenceOperationError } from "../errors.js"
import { ContentBlobDigest } from "./models.js"
import type {
  QuarantineDiagnosticSummary,
  QuarantinedRecordMetadata,
  QuarantineReasonCode,
  QuarantineRecordKind
} from "./models.js"
import type { QuarantineRepositoryService } from "./quarantineRepository.js"

/** Fixed, redacted identity for quarantining one malformed persisted row. */
export interface PersistedRowDiagnostic {
  readonly workspaceId: WorkspaceId
  readonly recordKind: QuarantineRecordKind
  readonly recordKey: QuarantinedRecordMetadata["recordKey"]
  readonly diagnosticCode: QuarantineReasonCode
  readonly diagnosticSummary: QuarantineDiagnosticSummary
  readonly observedAt: UtcTimestamp
  readonly row: unknown
}

/** Build row-level quarantine writes without retaining any malformed values. */
export const makePersistedRowQuarantine = (
  cryptoService: Crypto.Crypto,
  quarantine: QuarantineRepositoryService
) => {
  const digestRow = Effect.fn("PersistedRowQuarantine.digest")(function*(row: unknown) {
    const serialized = yield* Effect.try({
      try: () => JSON.stringify(row),
      catch: () => new PersistenceOperationError({ operation: "quarantine.encode-row" })
    })
    const bytes = yield* Effect.fromResult(
      Encoding.decodeBase64(Encoding.encodeBase64(serialized))
    ).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "quarantine.encode-row" }))
    )
    const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "quarantine.digest-row" }))
    )
    return ContentBlobDigest.make(Encoding.encodeHex(digest))
  })

  return Effect.fn("PersistedRowQuarantine.record")(function*(diagnostic: PersistedRowDiagnostic) {
    const payloadDigest = yield* digestRow(diagnostic.row)
    yield* quarantine.recordMalformed(diagnostic.workspaceId, {
      recordKind: diagnostic.recordKind,
      recordKey: diagnostic.recordKey,
      schemaVersion: 1,
      payloadDigest,
      diagnosticCode: diagnostic.diagnosticCode,
      diagnosticSummary: diagnostic.diagnosticSummary,
      observedAt: diagnostic.observedAt
    })
  })
}
