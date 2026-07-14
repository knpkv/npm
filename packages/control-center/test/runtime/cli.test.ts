import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"

import { classifyControlCenterCliArguments } from "../../src/server/cliArguments.js"
import { decodeControlCenterDataPaths } from "../../src/server/cliConfiguration.js"
import { PersistenceConfigError } from "../../src/server/persistence/errors.js"

describe("Control Center CLI", () => {
  it("accepts exactly the serve and recover-owner argument shapes", () => {
    assert.deepStrictEqual(classifyControlCenterCliArguments([]), { _tag: "serve" })
    assert.deepStrictEqual(
      classifyControlCenterCliArguments(["recover-owner"]),
      { _tag: "recover-owner" }
    )
    assert.deepStrictEqual(
      classifyControlCenterCliArguments(["recover-owner", "unexpected"]),
      { _tag: "invalid", command: "recover-owner unexpected" }
    )
  })

  it.effect("decodes derived data paths without defecting on invalid environment input", () =>
    Effect.gen(function*() {
      const valid = yield* decodeControlCenterDataPaths(".control-center")
      assert.match(valid.persistenceConfig.databaseUrl, /^file:\//u)
      assert.match(valid.persistenceConfig.blobRoot, /\/blobs$/u)
      assert.match(valid.secretRoot, /\/secrets$/u)

      const invalid = yield* decodeControlCenterDataPaths(`root-${"a".repeat(4_096)}`).pipe(Effect.result)
      assert.isTrue(Result.isFailure(invalid))
      if (Result.isFailure(invalid)) {
        assert.instanceOf(invalid.failure, PersistenceConfigError)
      }
    }).pipe(Effect.provide(NodeServices.layer)))
})
