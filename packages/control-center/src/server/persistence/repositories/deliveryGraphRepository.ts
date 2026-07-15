import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import type { WorkspaceId } from "../../../domain/identifiers.js"
import { Database } from "../Database.js"
import { DeliveryGraphInputError, DeliveryGraphQuery, DeliveryGraphWriteBatch } from "./delivery-graph/contract.js"
import { makeDeliveryGraphReader } from "./delivery-graph/read.js"
import { makeDeliveryGraphWriter } from "./delivery-graph/write.js"
import { mapPersistenceOperation } from "./internal.js"

export {
  DeliveryGraphInputError,
  DeliveryGraphQuery,
  DeliveryGraphReadResult,
  DeliveryGraphWriteBatch,
  DeliveryGraphWriteReceipt
} from "./delivery-graph/contract.js"

const makeDeliveryGraphRepository = Effect.gen(function*() {
  const database = yield* Database
  const writer = yield* makeDeliveryGraphWriter
  const reader = yield* makeDeliveryGraphReader

  const decodeBatch = Effect.fn("DeliveryGraphRepository.decodeBatch")(function*(input: unknown) {
    return yield* Schema.decodeUnknownEffect(DeliveryGraphWriteBatch)(input).pipe(
      Effect.mapError(() => new DeliveryGraphInputError({ operation: "write" }))
    )
  })

  const decodeQuery = Effect.fn("DeliveryGraphRepository.decodeQuery")(function*(input: unknown) {
    return yield* Schema.decodeUnknownEffect(DeliveryGraphQuery)(input).pipe(
      Effect.mapError(() => new DeliveryGraphInputError({ operation: "read" }))
    )
  })

  return {
    write: Effect.fn("DeliveryGraphRepository.write")(function*(
      workspaceId: WorkspaceId,
      input: unknown
    ) {
      const batch = yield* decodeBatch(input)
      yield* writer.ensureWorkspace(workspaceId, batch)
      return yield* database.transaction(writer.writeDecoded(batch)).pipe(
        mapPersistenceOperation("delivery-graph.write")
      )
    }),
    read: Effect.fn("DeliveryGraphRepository.read")(function*(
      workspaceId: WorkspaceId,
      input: unknown
    ) {
      const query = yield* decodeQuery(input)
      return yield* database.transaction(reader.readDecoded(workspaceId, query)).pipe(
        mapPersistenceOperation("delivery-graph.read")
      )
    })
  }
})

/** Deep workspace-safe persistence interface for the complete delivery graph ledger. */
export interface DeliveryGraphRepositoryService extends Success<typeof makeDeliveryGraphRepository> {}

/** Effect service exposing one atomic write and one tagged read operation. */
export class DeliveryGraphRepository extends Context.Service<
  DeliveryGraphRepository,
  DeliveryGraphRepositoryService
>()("@knpkv/control-center/DeliveryGraphRepository") {
  /** Layer binding graph persistence to the shared database and cryptography services. */
  static readonly layer = Layer.effect(DeliveryGraphRepository, makeDeliveryGraphRepository)
}
