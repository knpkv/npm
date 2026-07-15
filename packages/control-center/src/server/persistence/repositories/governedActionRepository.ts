import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { Database } from "../Database.js"
import type { PersistedRecordError, PersistenceOperationError, QuarantineWriteError } from "../errors.js"
import {
  GovernedActionCommitInput,
  GovernedActionInputError,
  GovernedActionReadInput
} from "./governed-action/contract.js"
import type { MalformedGovernedActionRecord } from "./governed-action/quarantine.js"
import { governedActionQuarantineDiagnostic } from "./governed-action/quarantine.js"
import { makeGovernedActionRead } from "./governed-action/read.js"
import { makeGovernedActionWrite } from "./governed-action/write.js"
import { mapPersistenceOperation } from "./internal.js"
import { makePersistedRowQuarantine } from "./persistedRowQuarantine.js"
import { QuarantineRepository } from "./quarantineRepository.js"

export * from "./governed-action/contract.js"

const makeGovernedActionRepository = Effect.gen(function*() {
  const database = yield* Database
  const cryptoService = yield* Crypto.Crypto
  const quarantine = yield* QuarantineRepository
  const quarantineRow = makePersistedRowQuarantine(cryptoService, quarantine)
  const reader = yield* makeGovernedActionRead
  const writer = yield* makeGovernedActionWrite

  const isMalformedGovernedActionRecord = (failure: unknown): failure is MalformedGovernedActionRecord =>
    Predicate.isTagged("MalformedGovernedActionRecord")(failure) &&
    Predicate.hasProperty(failure, "error") &&
    Predicate.isTagged("PersistedRecordError")(failure.error) &&
    Predicate.hasProperty(failure, "row")

  const quarantineMalformed = Effect.fn("GovernedActionRepository.quarantineMalformed")(function*(
    malformed: MalformedGovernedActionRecord
  ) {
    const diagnostic = governedActionQuarantineDiagnostic(malformed.error)
    if (diagnostic !== null) {
      yield* quarantineRow({
        workspaceId: malformed.error.workspaceId,
        ...diagnostic,
        recordKey: malformed.error.recordKey,
        observedAt: yield* DateTime.now,
        row: malformed.row
      })
    }
    return yield* malformed.error
  })

  const transactCaptured = <Value, Failure, Requirements>(
    effect: Effect.Effect<Value, Failure, Requirements>
  ) =>
    database.transaction(effect).pipe(
      mapPersistenceOperation("governed-action.read"),
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

  const captureCommitted = <Value, Failure, Requirements>(
    effect: Effect.Effect<Value, Failure, Requirements>
  ) =>
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

  const commit = Effect.fn("GovernedActionRepository.commit")(function*(input: unknown) {
    const request = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionCommitInput))(input).pipe(
      Effect.mapError(() => new GovernedActionInputError({ operation: "commit", reason: "invalid-request" }))
    )
    return yield* captureCommitted(
      writer.commit(request).pipe(Effect.provideService(Crypto.Crypto, cryptoService))
    )
  })

  const read = Effect.fn("GovernedActionRepository.read")(function*(input: unknown) {
    const request = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionReadInput))(input).pipe(
      Effect.mapError(() => new GovernedActionInputError({ operation: "read", reason: "invalid-request" }))
    )
    return yield* transactCaptured(
      reader.read(request).pipe(Effect.provideService(Crypto.Crypto, cryptoService))
    )
  })

  return { commit, read }
})

/** Deep server-only repository for governed action authority, lifecycle, and audit. */
export interface GovernedActionRepositoryService extends Success<typeof makeGovernedActionRepository> {}

/** Atomic governed-action persistence service. It never exposes provider execution capability. */
export class GovernedActionRepository extends Context.Service<
  GovernedActionRepository,
  GovernedActionRepositoryService
>()("@knpkv/control-center/GovernedActionRepository") {
  /** Layer binding governed-action persistence to database, cryptography, and quarantine. */
  static readonly layer = Layer.effect(GovernedActionRepository, makeGovernedActionRepository)
}
