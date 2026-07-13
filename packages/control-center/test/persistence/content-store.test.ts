import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  ContentMetadataMismatchError,
  Persistence,
  persistenceLayer,
  type PutContentInput,
  RecordNotFoundError
} from "../../src/server/persistence/index.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { fixtureTimestamps, fixtureWorkspaceIds, makePersistenceTestConfig } from "./fixtures.js"

const WORKSPACE_A = fixtureWorkspaceIds.alpha
const WORKSPACE_B = fixtureWorkspaceIds.beta
const CREATED_AT = fixtureTimestamps.created
const VERIFIED_EARLIER = fixtureTimestamps.verifiedEarlier
const VERIFIED_LATER = fixtureTimestamps.verifiedLater

describe("ContentStore", () => {
  it.effect("publishes bytes first, isolates workspaces, and preserves verification monotonicity", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-content-")
      yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        assert.strictEqual(typeof persistence.people.createRoleAssignment, "function")
        assert.strictEqual(typeof persistence.people.updateRoleAssignment, "function")
        const bytes = new Uint8Array([10, 20, 30, 40])
        const input: PutContentInput = {
          bytes,
          classification: "durable",
          mimeType: "application/octet-stream",
          createdAt: CREATED_AT
        }

        yield* persistence.workspaces.create(WORKSPACE_A, {
          displayName: WorkspaceName.make("Payments"),
          createdAt: CREATED_AT
        })

        const orphaned = yield* persistence.content.put(WORKSPACE_B, input).pipe(Effect.result)
        assert.isTrue(Result.isFailure(orphaned))

        yield* persistence.workspaces.create(WORKSPACE_B, {
          displayName: WorkspaceName.make("Identity"),
          createdAt: CREATED_AT
        })
        const adopted = yield* persistence.content.put(WORKSPACE_B, input)
        assert.isFalse(adopted.stored)

        const published = yield* persistence.content.put(WORKSPACE_A, input)
        assert.isTrue(published.stored)
        assert.deepStrictEqual(
          Array.from(yield* persistence.content.readAll(WORKSPACE_A, published.metadata.digest)),
          Array.from(bytes)
        )

        const missing = yield* persistence.content.readAll(
          fixtureWorkspaceIds.missing,
          published.metadata.digest
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(missing))
        if (Result.isFailure(missing)) assert.instanceOf(missing.failure, RecordNotFoundError)

        const later = yield* persistence.content.verify(
          WORKSPACE_A,
          published.metadata.digest,
          VERIFIED_LATER
        )
        const earlier = yield* persistence.content.verify(
          WORKSPACE_A,
          published.metadata.digest,
          VERIFIED_EARLIER
        )
        assert.deepStrictEqual(later.metadata.lastVerifiedAt, VERIFIED_LATER)
        assert.deepStrictEqual(earlier.metadata.lastVerifiedAt, VERIFIED_LATER)

        const conflicting = yield* persistence.content.put(WORKSPACE_A, {
          ...input,
          mimeType: "text/plain"
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(conflicting))
        if (Result.isFailure(conflicting)) {
          assert.instanceOf(conflicting.failure, ContentMetadataMismatchError)
        }
      }).pipe(Effect.provide(persistenceLayer(config)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("does not certify bytes whose persisted length metadata is inconsistent", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-content-length-")
      const digest = yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        yield* persistence.workspaces.create(WORKSPACE_A, {
          displayName: WorkspaceName.make("Payments"),
          createdAt: CREATED_AT
        })
        const stored = yield* persistence.content.put(WORKSPACE_A, {
          bytes: new Uint8Array([1, 2, 3]),
          classification: "durable",
          mimeType: "application/octet-stream",
          createdAt: CREATED_AT
        })
        return stored.metadata.digest
      }).pipe(Effect.provide(persistenceLayer(config)), Effect.scoped)

      yield* Effect.gen(function*() {
        const database = yield* Database
        yield* database.sql`UPDATE content_blobs
          SET byte_length = 99
          WHERE workspace_id = ${WORKSPACE_A} AND digest = ${digest}`
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)

      const verified = yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        return yield* persistence.content.verify(WORKSPACE_A, digest, VERIFIED_LATER)
      }).pipe(Effect.provide(persistenceLayer(config)), Effect.scoped, Effect.result)
      assert.isTrue(Result.isFailure(verified))
      if (Result.isFailure(verified)) {
        assert.instanceOf(verified.failure, ContentMetadataMismatchError)
      }

      const rows = yield* Effect.gen(function*() {
        const database = yield* Database
        return yield* database.sql<{ readonly lastVerifiedAt: string | null }>`SELECT
          last_verified_at AS lastVerifiedAt
          FROM content_blobs
          WHERE workspace_id = ${WORKSPACE_A} AND digest = ${digest}`
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)
      assert.deepStrictEqual(rows, [{ lastVerifiedAt: null }])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
