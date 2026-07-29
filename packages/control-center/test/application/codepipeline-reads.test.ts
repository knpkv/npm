import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { NegotiatedPluginDescriptorV1 } from "../../src/domain/plugins/descriptor.js"
import { PluginPipelineArtifactRangeRequestV1, PluginPipelineLogPageRequestV1 } from "../../src/domain/plugins/index.js"
import { makeCodePipelineReads } from "../../src/server/application/codePipelineReads.js"
import { PluginAuthorizationFailure } from "../../src/server/plugins/failures.js"
import { PluginConnection, type PluginConnectionV1 } from "../../src/server/plugins/PluginConnection.js"
import type { PluginConnectionMapV1 } from "../../src/server/plugins/PluginConnectionMap.js"

const WORKSPACE_ID = WorkspaceId.make("018f22d2-4d7a-7abc-8def-1234567890ab")
const OTHER_WORKSPACE_ID = WorkspaceId.make("018f22d2-4d7a-7abc-8def-1234567890ac")
const CONNECTION_ID = PluginConnectionId.make("018f22d2-4d7a-7abc-8def-1234567890ad")

const descriptor = Schema.decodeUnknownSync(NegotiatedPluginDescriptorV1)({
  descriptor: {
    contractId: "dev.knpkv.control-center.plugin",
    contractVersion: { major: 1, minor: 0, patch: 0 },
    pluginId: "dev.knpkv.test-codepipeline",
    adapterVersion: { major: 1, minor: 0, patch: 0 },
    displayName: "Test CodePipeline",
    configurationFields: [],
    capabilities: [
      {
        capabilityId: "pipeline.logs",
        supportedVersions: [1],
        requirement: "required"
      },
      {
        capabilityId: "pipeline.artifact",
        supportedVersions: [1],
        requirement: "required"
      }
    ]
  },
  capabilities: [
    { capabilityId: "pipeline.logs", version: 1 },
    { capabilityId: "pipeline.artifact", version: 1 }
  ]
})

const action = {
  entity: {
    entityType: "aws.codepipeline.action",
    vendorImmutableId: "execution-1#action-1"
  },
  executionId: "execution-1",
  actionExecutionId: "action-1",
  expectedRevision: "Succeeded:2026-07-16T09:04:00.000Z"
}

describe("CodePipelineReads", () => {
  it.effect("rejects a cross-workspace lease before any pipeline provider read", () =>
    Effect.gen(function*() {
      const providerCalls = yield* Ref.make(0)
      const connection: PluginConnectionV1 = {
        descriptor,
        discover: Effect.die("not used"),
        health: Effect.die("not used"),
        sync: () => Stream.die("not used"),
        readEntity: () => Effect.die("not used"),
        diff: Option.none(),
        pipeline: Option.some({
          readLogPage: () =>
            Ref.update(providerCalls, (count) => count + 1).pipe(
              Effect.as({ events: [], nextCursor: null })
            ),
          readArtifactRange: () => Effect.die("not used")
        }),
        proposeAction: () => Effect.die("not used")
      }
      const map: PluginConnectionMapV1 = {
        contextEffect: ({ workspaceId }) =>
          workspaceId === WORKSPACE_ID
            ? Effect.succeed(Context.make(PluginConnection, connection))
            : Effect.fail(new PluginAuthorizationFailure({ operation: "plugin-lease" })),
        invalidate: () => Effect.void
      }
      const reads = makeCodePipelineReads(map)
      const result = yield* reads.logs({
        workspaceId: OTHER_WORKSPACE_ID,
        pluginConnectionId: CONNECTION_ID,
        request: Schema.decodeUnknownSync(PluginPipelineLogPageRequestV1)({
          action,
          cursor: null,
          limit: 10
        })
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "ApplicationServiceUnavailable")
      }
      assert.strictEqual(yield* Ref.get(providerCalls), 0)
    }))

  it.effect("returns artifact bytes without exposing provider coordinates", () =>
    Effect.gen(function*() {
      const connection: PluginConnectionV1 = {
        descriptor,
        discover: Effect.die("not used"),
        health: Effect.die("not used"),
        sync: () => Stream.die("not used"),
        readEntity: () => Effect.die("not used"),
        diff: Option.none(),
        pipeline: Option.some({
          readLogPage: () => Effect.die("not used"),
          readArtifactRange: () =>
            Effect.succeed({
              bytesBase64: "AQID",
              totalBytes: 3,
              contentType: "application/octet-stream",
              filename: "BuildOutput.zip"
            })
        }),
        proposeAction: () => Effect.die("not used")
      }
      const map: PluginConnectionMapV1 = {
        contextEffect: () => Effect.succeed(Context.make(PluginConnection, connection)),
        invalidate: () => Effect.void
      }
      const reads = makeCodePipelineReads(map)
      const artifact = yield* reads.artifact({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CONNECTION_ID,
        request: Schema.decodeUnknownSync(PluginPipelineArtifactRangeRequestV1)({
          action,
          direction: "output",
          artifactName: "BuildOutput",
          offset: 0,
          length: 3
        })
      })
      const chunks = yield* Stream.runCollect(artifact.body)

      assert.strictEqual(artifact.contentLength, 3)
      assert.strictEqual(artifact.filename, "BuildOutput.zip")
      assert.deepStrictEqual(Array.from(chunks[0] ?? []), [1, 2, 3])
      assert.deepStrictEqual(Object.keys(artifact).sort(), ["body", "contentLength", "filename"])
    }))
})
