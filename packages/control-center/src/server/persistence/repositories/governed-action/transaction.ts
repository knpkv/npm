import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"

import { Database } from "../../Database.js"
import type { PersistedRecordError, PersistenceOperationError, QuarantineWriteError } from "../../errors.js"
import { mapPersistenceOperation } from "../internal.js"
import { makePersistedRowQuarantine } from "../persistedRowQuarantine.js"
import { QuarantineRepository } from "../quarantineRepository.js"
import type { GovernedActionReadInput } from "./contract.js"
import type { MalformedGovernedActionRecord } from "./quarantine.js"
import { governedActionQuarantineDiagnostic } from "./quarantine.js"
import { makeGovernedActionRead } from "./read.js"

const isMalformedGovernedActionRecord = (failure: unknown): failure is MalformedGovernedActionRecord =>
  Predicate.isTagged("MalformedGovernedActionRecord")(failure) &&
  Predicate.hasProperty(failure, "error") &&
  Predicate.isTagged("PersistedRecordError")(failure.error) &&
  Predicate.hasProperty(failure, "row")

/**
 * Build the rollback-then-quarantine boundary shared by verified governed-action transactions.
 * Raw malformed rows never escape this module or enter the quarantine table before rollback.
 */
export const makeGovernedActionTransaction = Effect.gen(function*() {
  const database = yield* Database
  const clock = yield* Clock.Clock
  const cryptoService = yield* Crypto.Crypto
  const quarantine = yield* QuarantineRepository
  const quarantineRow = makePersistedRowQuarantine(cryptoService, quarantine)
  const reader = yield* makeGovernedActionRead

  const quarantineMalformed = Effect.fn("GovernedActionTransaction.quarantineMalformed")(function*(
    malformed: MalformedGovernedActionRecord
  ) {
    const diagnostic = governedActionQuarantineDiagnostic(malformed.error)
    if (diagnostic !== null) {
      yield* quarantineRow({
        workspaceId: malformed.error.workspaceId,
        ...diagnostic,
        recordKey: malformed.error.recordKey,
        observedAt: DateTime.makeUnsafe(yield* clock.currentTimeMillis),
        row: malformed.row
      })
    }
    return yield* malformed.error
  })

  const capture = <Value, Failure, Requirements>(
    effect: Effect.Effect<Value, Failure, Requirements>
  ): Effect.Effect<
    Value,
    Failure | PersistedRecordError | PersistenceOperationError | QuarantineWriteError,
    Requirements
  > =>
    effect.pipe(
      Effect.result,
      Effect.flatMap(
        (
          result
        ): Effect.Effect<
          Value,
          Failure | PersistedRecordError | PersistenceOperationError | QuarantineWriteError,
          Requirements
        > => {
          if (Result.isSuccess(result)) return Effect.succeed(result.success)
          return isMalformedGovernedActionRecord(result.failure)
            ? quarantineMalformed(result.failure)
            : Effect.fail(result.failure)
        }
      )
    )

  const transact = <Value, Failure, Requirements>(
    operation: string,
    effect: Effect.Effect<Value, Failure, Requirements>
  ): Effect.Effect<
    Value,
    Failure | PersistedRecordError | PersistenceOperationError | QuarantineWriteError,
    Requirements
  > => capture(database.transaction(effect).pipe(mapPersistenceOperation(operation)))

  const read = (request: GovernedActionReadInput) =>
    reader.read(request).pipe(Effect.provideService(Crypto.Crypto, cryptoService))

  return { capture, read, transact }
})
