import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"

import {
  AgentId,
  EntityId,
  EnvironmentId,
  PersonId,
  PluginConnectionId,
  ReleaseId,
  RoleAssignmentId,
  WorkspaceId
} from "../../src/domain/identifiers.js"

const CANONICAL_UUID_V7 = "01890f6f-6d6a-7cc0-98d2-000000000001"

const identifierSchemas = [
  { name: "workspace", schema: WorkspaceId },
  { name: "release", schema: ReleaseId },
  { name: "entity", schema: EntityId },
  { name: "person", schema: PersonId },
  { name: "agent", schema: AgentId },
  { name: "environment", schema: EnvironmentId },
  { name: "plugin connection", schema: PluginConnectionId },
  { name: "role assignment", schema: RoleAssignmentId }
]

describe("canonical identifiers", () => {
  it.each(identifierSchemas)("decodes and encodes a canonical $name ID", ({ schema }) => {
    const decoded = Schema.decodeUnknownResult(schema)(CANONICAL_UUID_V7)

    assert.isTrue(Result.isSuccess(decoded))

    if (Result.isSuccess(decoded)) {
      assert.strictEqual(Schema.encodeSync(schema)(decoded.success), CANONICAL_UUID_V7)
    }
  })

  it.each(identifierSchemas)("canonicalizes an uppercase $name ID", ({ schema }) => {
    const decoded = Schema.decodeUnknownResult(schema)(CANONICAL_UUID_V7.toUpperCase())

    assert.isTrue(Result.isSuccess(decoded))

    if (Result.isSuccess(decoded)) {
      assert.strictEqual(decoded.success, CANONICAL_UUID_V7)
    }
  })

  it.each(identifierSchemas)("rejects a non-v7 $name UUID", ({ schema }) => {
    const decoded = Schema.decodeUnknownResult(schema)("01890f6f-6d6a-4cc0-98d2-000000000001")

    assert.isTrue(Result.isFailure(decoded))
  })

  it.each(identifierSchemas)("rejects a malformed $name ID", ({ schema }) => {
    const decoded = Schema.decodeUnknownResult(schema)("not-a-uuid")

    assert.isTrue(Result.isFailure(decoded))
  })

  it.effect.prop(
    "every generated workspace ID has a stable canonical encoding",
    [WorkspaceId],
    ([workspaceId]) =>
      Effect.gen(function*() {
        const encoded = yield* Schema.encodeEffect(WorkspaceId)(workspaceId)
        const decoded = yield* Schema.decodeUnknownEffect(WorkspaceId)(encoded)

        assert.strictEqual(encoded, encoded.toLowerCase())
        assert.strictEqual(decoded, workspaceId)
      })
  )
})
