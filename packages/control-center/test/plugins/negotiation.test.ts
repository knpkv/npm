import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref, Result } from "effect"

import { negotiatePluginDescriptorV1 } from "../../src/server/plugins/negotiation.js"

const descriptor = (capabilities: ReadonlyArray<unknown>, contractMajor = 1): unknown => ({
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: contractMajor, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.fake",
  adapterVersion: { major: 1, minor: 0, patch: 0 },
  displayName: "Deterministic fake",
  configurationFields: [],
  capabilities
})

const supportedEntityRead = {
  capabilityId: "entity.read",
  supportedVersions: [1],
  requirement: "required"
}

describe("plugin contract negotiation", () => {
  it.effect("rejects an unknown contract major before construction", () =>
    Effect.gen(function*() {
      const constructed = yield* Ref.make(false)
      const outcome = yield* negotiatePluginDescriptorV1(descriptor([supportedEntityRead], 2)).pipe(
        Effect.tap(() => Ref.set(constructed, true)),
        Effect.result
      )

      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginUnsupportedCapabilityFailure")
        assert.strictEqual(outcome.failure.diagnosticCode, "plugin-contract-major-unsupported")
      }
      assert.isFalse(yield* Ref.get(constructed))
    }))

  it.effect("rejects a malformed descriptor before construction", () =>
    Effect.gen(function*() {
      const constructed = yield* Ref.make(false)
      const outcome = yield* negotiatePluginDescriptorV1({
        contractId: "dev.knpkv.control-center.plugin",
        contractVersion: { major: 1, minor: 0, patch: 0 },
        capabilities: "not-an-array"
      }).pipe(
        Effect.tap(() => Ref.set(constructed, true)),
        Effect.result
      )

      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginMalformedResponseFailure")
      }
      assert.isFalse(yield* Ref.get(constructed))
    }))

  it.effect("rejects an unsupported required capability version", () =>
    Effect.gen(function*() {
      const outcome = yield* negotiatePluginDescriptorV1(
        descriptor([
          {
            capabilityId: "entity.read",
            supportedVersions: [2],
            requirement: "required"
          }
        ])
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginUnsupportedCapabilityFailure")
        assert.strictEqual(outcome.failure.diagnosticCode, "plugin-required-capability-unsupported")
      }
    }))

  it.effect("omits an unsupported optional version and selects the highest common version", () =>
    Effect.gen(function*() {
      const negotiated = yield* negotiatePluginDescriptorV1(
        descriptor([
          supportedEntityRead,
          {
            capabilityId: "diff.content",
            supportedVersions: [2],
            requirement: "optional"
          }
        ])
      )

      assert.deepStrictEqual(negotiated.capabilities, [{ capabilityId: "entity.read", version: 1 }])
    }))
})
