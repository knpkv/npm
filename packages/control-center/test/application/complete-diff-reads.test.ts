import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { type CompleteDiffContentRange, DiffFileAnchor } from "../../src/api/diff.js"
import { PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { NegotiatedPluginDescriptorV1 } from "../../src/domain/plugins/descriptor.js"
import {
  type PluginDiffInventoryEntryV1,
  PluginPageCursorV1,
  PluginRelativePathV1
} from "../../src/domain/plugins/events.js"
import { Revision, VendorImmutableId } from "../../src/domain/sourceRevision.js"
import { ApplicationConflict } from "../../src/server/api/ApplicationServices.js"
import { makeCompleteDiffReads } from "../../src/server/application/completeDiffReads.js"
import {
  PluginConnection,
  type PluginConnectionV1,
  type PluginDiffReaderV1
} from "../../src/server/plugins/PluginConnection.js"
import type { PluginConnectionMapV1 } from "../../src/server/plugins/PluginConnectionMap.js"

const workspaceId = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000001")
const pluginConnectionId = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000081")
const vendorImmutableId = VendorImmutableId.make("184")
const revision = Revision.make("revision-9")
const modifiedStatus: typeof PluginDiffInventoryEntryV1.Type.status = "modified"
const descriptor = Schema.decodeUnknownSync(NegotiatedPluginDescriptorV1)({
  descriptor: {
    contractId: "dev.knpkv.control-center.plugin",
    contractVersion: { major: 1, minor: 0, patch: 0 },
    pluginId: "dev.knpkv.test.diff",
    adapterVersion: { major: 1, minor: 0, patch: 0 },
    displayName: "Diff test",
    configurationFields: [],
    capabilities: [
      { capabilityId: "diff.inventory", supportedVersions: [1, 2], requirement: "required" },
      { capabilityId: "diff.content", supportedVersions: [1, 2], requirement: "required" }
    ]
  },
  capabilities: [
    { capabilityId: "diff.inventory", version: 2 },
    { capabilityId: "diff.content", version: 2 }
  ]
})

const mapFor = (connection: PluginConnectionV1): PluginConnectionMapV1 => ({
  contextEffect: () => Effect.succeed(Context.make(PluginConnection, connection)),
  invalidate: () => Effect.void
})

const baseConnection = (diff: PluginConnectionV1["diff"]): PluginConnectionV1 => ({
  descriptor,
  discover: Effect.die("unused"),
  health: Effect.die("unused"),
  sync: () => Stream.empty,
  readEntity: () => Effect.die("unused"),
  diff: Option.map(diff, (reader) => ({
    ...reader,
    readInventoryPageV2: reader.readInventoryPage,
    readContentRangeV2: reader.readContentRange
  })),
  proposeAction: () => Effect.die("unused")
})

const makeReads = (
  connection: PluginConnectionV1,
  lookup: (requestedRevision: Revision) => Effect.Effect<{
    readonly revision: Revision
    readonly baseRevision: Revision
    readonly headRevision: Revision
  }, ApplicationConflict> = (requestedRevision) =>
    Effect.succeed({
      revision: requestedRevision,
      baseRevision: Revision.make("base-commit"),
      headRevision: Revision.make("head-commit")
    })
) =>
  Crypto.Crypto.pipe(
    Effect.map((cryptoService) =>
      makeCompleteDiffReads(mapFor(connection), cryptoService, (scope) => lookup(scope.revision))
    ),
    Effect.provide(NodeCrypto.layer)
  )

describe("CompleteDiffReads", () => {
  it.effect("collects all five provider pages before reporting a 500-file inventory ready", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const connection = baseConnection(Option.some<PluginDiffReaderV1>({
        readInventoryPage: ({ cursor }) =>
          Effect.gen(function*() {
            const page = cursor === null ? 0 : Number(cursor)
            yield* Ref.update(calls, (value) => value + 1)
            return {
              entries: Array.from({ length: 100 }, (_, index) => ({
                path: PluginRelativePathV1.make(
                  `src/file-${String(page * 100 + index).padStart(3, "0")}.ts`
                ),
                previousPath: null,
                status: modifiedStatus,
                binary: false,
                generated: false,
                oversized: false
              })),
              nextCursor: page === 4 ? null : PluginPageCursorV1.make(String(page + 1))
            }
          }),
        readContentRange: () => Effect.die("unused")
      }))
      const reads = yield* makeReads(connection)
      const inventory = yield* reads.inventory({
        workspaceId,
        pluginConnectionId,
        vendorImmutableId,
        revision
      })

      assert.isTrue(inventory.ready)
      assert.strictEqual(inventory.entries.length, 500)
      assert.strictEqual(yield* Ref.get(calls), 5)
      assert.strictEqual(new Set(inventory.entries.map(({ anchor }) => anchor)).size, 500)
    }))

  it.effect("preserves explicit provider-unavailable content without failing the inventory", () =>
    Effect.gen(function*() {
      const connection = baseConnection(Option.some<PluginDiffReaderV1>({
        readInventoryPage: () => Effect.die("unused"),
        readContentRange: () =>
          Effect.succeed({
            bytesBase64: null,
            totalBytes: null,
            unavailableReason: "provider-unavailable"
          })
      }))
      const reads = yield* makeReads(connection)
      const content = yield* reads.content({
        workspaceId,
        pluginConnectionId,
        vendorImmutableId,
        revision,
        anchor: DiffFileAnchor.make(
          "sha256:12a936386c815ae967006bbb95377860b3aa4e7000a05dda7486cf0a071d7a1d"
        ),
        path: PluginRelativePathV1.make("src/file.ts"),
        previousPath: null,
        status: modifiedStatus,
        side: "after",
        offset: 0,
        length: 1_048_576
      })

      assert.strictEqual(content.unavailableReason, "provider-unavailable")
      assert.strictEqual(content.bytesBase64, null)
    }))

  it.effect("rejects mismatched content identity before calling the provider", () =>
    Effect.gen(function*() {
      const contentCalls = yield* Ref.make(0)
      const missingContent = {
        bytesBase64: null,
        totalBytes: null,
        unavailableReason: "missing"
      } satisfies CompleteDiffContentRange
      const connection = baseConnection(Option.some<PluginDiffReaderV1>({
        readInventoryPage: () => Effect.die("unused"),
        readContentRange: () =>
          Ref.update(contentCalls, (count) => count + 1).pipe(
            Effect.as(missingContent)
          )
      }))
      const reads = yield* makeReads(connection)
      const result = yield* reads.content({
        workspaceId,
        pluginConnectionId,
        vendorImmutableId,
        revision,
        anchor: DiffFileAnchor.make(
          "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        ),
        path: PluginRelativePathV1.make("src/file.ts"),
        previousPath: null,
        status: modifiedStatus,
        side: "after",
        offset: 0,
        length: 1_048_576
      }).pipe(Effect.result)

      assert.strictEqual(result._tag, "Failure")
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "ApplicationConflict")
      assert.strictEqual(yield* Ref.get(contentCalls), 0)
    }))

  it.effect("rejects a stored projection whose provider revision does not match the request", () =>
    Effect.gen(function*() {
      const inventoryCalls = yield* Ref.make(0)
      const connection = baseConnection(Option.some<PluginDiffReaderV1>({
        readInventoryPage: () =>
          Ref.update(inventoryCalls, (count) => count + 1).pipe(
            Effect.as({ entries: [], nextCursor: null })
          ),
        readContentRange: () => Effect.die("unused")
      }))
      const reads = yield* makeReads(
        connection,
        () => Effect.fail(new ApplicationConflict())
      )
      const result = yield* reads.inventory({
        workspaceId,
        pluginConnectionId,
        vendorImmutableId,
        revision
      }).pipe(Effect.result)

      assert.strictEqual(result._tag, "Failure")
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "ApplicationConflict")
      assert.strictEqual(yield* Ref.get(inventoryCalls), 0)
    }))

  it.effect("keeps SHA-256 anchors stable and changes them with canonical diff identity", () =>
    Effect.gen(function*() {
      const entry = yield* Ref.make<typeof PluginDiffInventoryEntryV1.Type>({
        path: PluginRelativePathV1.make("src/current.ts"),
        previousPath: PluginRelativePathV1.make("src/previous.ts"),
        status: "renamed",
        binary: false,
        generated: false,
        oversized: false
      })
      const connection = baseConnection(Option.some<PluginDiffReaderV1>({
        readInventoryPage: () => Ref.get(entry).pipe(Effect.map((value) => ({ entries: [value], nextCursor: null }))),
        readContentRange: () => Effect.die("unused")
      }))
      const reads = yield* makeReads(connection)
      const inventoryFor = (requestedRevision: Revision) =>
        reads.inventory({
          workspaceId,
          pluginConnectionId,
          vendorImmutableId,
          revision: requestedRevision
        })

      const initial = yield* inventoryFor(revision)
      const repeated = yield* inventoryFor(revision)
      yield* Ref.update(entry, (value) => ({
        ...value,
        path: PluginRelativePathV1.make("src/changed.ts")
      }))
      const changedPath = yield* inventoryFor(revision)
      yield* Ref.update(entry, (value) => ({
        ...value,
        status: modifiedStatus
      }))
      const changedStatus = yield* inventoryFor(revision)
      yield* Ref.update(entry, (value) => ({
        ...value,
        previousPath: PluginRelativePathV1.make("src/another-previous.ts")
      }))
      const changedPreviousPath = yield* inventoryFor(revision)
      const changedRevision = yield* inventoryFor(Revision.make("revision-10"))
      const anchors = [
        initial.entries[0]?.anchor,
        changedPath.entries[0]?.anchor,
        changedStatus.entries[0]?.anchor,
        changedPreviousPath.entries[0]?.anchor,
        changedRevision.entries[0]?.anchor
      ]

      assert.strictEqual(initial.entries[0]?.anchor, repeated.entries[0]?.anchor)
      assert.strictEqual(
        initial.entries[0]?.anchor,
        "sha256:c45cfa1066e5501e9e575280dcb294ed0af3489b1e83b4daf08f4e6f5310afcf"
      )
      assert.match(initial.entries[0]?.anchor ?? "", /^sha256:[0-9a-f]{64}$/u)
      assert.throws(() => Schema.decodeUnknownSync(DiffFileAnchor)("diff:legacy-anchor"))
      assert.strictEqual(new Set(anchors).size, anchors.length)
    }))

  it.effect("keeps valid maximum-length rename paths inside the fixed anchor schema", () =>
    Effect.gen(function*() {
      const path = PluginRelativePathV1.make(`new/${"n".repeat(4_092)}`)
      const previousPath = PluginRelativePathV1.make(`old/${"o".repeat(4_092)}`)
      const connection = baseConnection(Option.some<PluginDiffReaderV1>({
        readInventoryPage: () =>
          Effect.succeed({
            entries: [{
              path,
              previousPath,
              status: "renamed",
              binary: false,
              generated: false,
              oversized: false
            }],
            nextCursor: null
          }),
        readContentRange: () => Effect.die("unused")
      }))
      const reads = yield* makeReads(connection)
      const inventory = yield* reads.inventory({
        workspaceId,
        pluginConnectionId,
        vendorImmutableId,
        revision
      })

      assert.strictEqual(path.length, 4_096)
      assert.strictEqual(previousPath.length, 4_096)
      assert.match(inventory.entries[0]?.anchor ?? "", /^sha256:[0-9a-f]{64}$/u)
    }))
})
