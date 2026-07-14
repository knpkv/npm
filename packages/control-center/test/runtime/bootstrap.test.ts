import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Schema } from "effect"

import { Actor } from "../../src/domain/actors.js"
import { PersonId } from "../../src/domain/identifiers.js"
import { authLayerFromDatabase } from "../../src/server/auth/Auth.js"
import { databaseLayer } from "../../src/server/persistence/Database.js"
import { persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { makeControlCenterBootstrap } from "../../src/server/runtime/Bootstrap.js"
import { fixtureWorkspaceIds, makePersistenceTestConfig } from "../persistence/fixtures.js"

const owner = Actor.make({
  _tag: "human",
  personId: Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000091")
})

describe("Control Center bootstrap", () => {
  it.effect("creates one workspace and never reissues its first owner pairing code", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-runtime-bootstrap-")
      const database = databaseLayer(config)
      const services = Layer.merge(
        persistenceLayerFromDatabase(config),
        authLayerFromDatabase
      ).pipe(Layer.provide(database))
      const options = {
        workspaceId: fixtureWorkspaceIds.alpha,
        workspaceName: WorkspaceName.make("Control Center"),
        owner
      }

      const result = yield* Effect.gen(function*() {
        const first = yield* makeControlCenterBootstrap(options)
        const restarted = yield* makeControlCenterBootstrap(options)
        return { first, restarted }
      }).pipe(Effect.provide(services))

      assert.strictEqual(result.first._tag, "pairing-issued")
      if (result.first._tag === "pairing-issued") {
        assert.match(Redacted.value(result.first.pairingCode), /^[0-9a-f]{64}$/u)
      }
      assert.deepStrictEqual(result.restarted, {
        _tag: "already-initialized",
        workspaceId: fixtureWorkspaceIds.alpha
      })
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
