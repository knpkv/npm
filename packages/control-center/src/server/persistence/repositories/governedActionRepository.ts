import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import {
  GovernedActionCommitInput,
  GovernedActionInputError,
  GovernedActionReadInput
} from "./governed-action/contract.js"
import { makeGovernedActionTransaction } from "./governed-action/transaction.js"
import { makeGovernedActionWrite } from "./governed-action/write.js"

export * from "./governed-action/contract.js"

const makeGovernedActionRepository = Effect.gen(function*() {
  const transaction = yield* makeGovernedActionTransaction
  const writer = yield* makeGovernedActionWrite

  const commit = Effect.fn("GovernedActionRepository.commit")(function*(input: unknown) {
    const request = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionCommitInput))(input).pipe(
      Effect.mapError(() => new GovernedActionInputError({ operation: "commit", reason: "invalid-request" }))
    )
    return yield* transaction.capture(writer.commit(request))
  })

  const read = Effect.fn("GovernedActionRepository.read")(function*(input: unknown) {
    const request = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionReadInput))(input).pipe(
      Effect.mapError(() => new GovernedActionInputError({ operation: "read", reason: "invalid-request" }))
    )
    return yield* transaction.transact("governed-action.read", transaction.read(request))
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
