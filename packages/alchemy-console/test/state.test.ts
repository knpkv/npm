import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { decodeResource } from "../src/state.js"

layer(NodeServices.layer)("state metadata boundary", (it) => {
  it.effect("drops props, attrs, old state and nested redacted payloads", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const text = yield* fs.readFileString(path.join(import.meta.dirname, "fixtures/resource.json"))
      const resource = yield* decodeResource(text)
      expect(resource).toEqual({
        fqn: "Storage/Assets",
        logicalId: "Assets",
        resourceType: "AWS.S3.Bucket",
        status: "created",
        parent: "Storage",
        providerId: null,
        account: null,
        region: null,
        consoleUrl: null
      })
      expect(JSON.stringify(resource)).not.toContain("fixture-secret")
      expect(JSON.stringify(resource)).not.toContain("fixture-assets")
    }))

  it.effect("masks marker objects even when metadata contains sibling values", () =>
    Effect.gen(function*() {
      const resource = yield* decodeResource(JSON.stringify({
        fqn: "Assets",
        logicalId: "Assets",
        resourceType: { __redacted__: "fixture-secret", extra: "fixture-secret" },
        status: "created"
      }))
      expect(resource?.resourceType).toBe("<redacted>")
      expect(JSON.stringify(resource)).not.toContain("fixture-secret")
    }))

  it.effect("validates and excludes action rows without returning their input/output", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      expect(yield* decodeResource(yield* fs.readFileString(path.join(import.meta.dirname, "fixtures/action.json"))))
        .toBeNull()
    }))

  it.effect("invalid persisted rows fail without reflecting source contents", () =>
    Effect.gen(function*() {
      for (
        const text of [
          "fixture-secret",
          "{\"fqn\":\"fixture-secret\",\"status\":\"future\"}",
          "",
          "{\"__redacted__\":\"fixture-secret\",\"fqn\":\"fixture-secret\",\"logicalId\":\"fixture-secret\",\"resourceType\":\"fixture-secret\",\"status\":\"created\"}"
        ]
      ) {
        const result = yield* Effect.result(decodeResource(text))
        expect(result._tag).toBe("Failure")
        expect(JSON.stringify(result)).not.toContain("fixture-secret")
      }
    }))
})
