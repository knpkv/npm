import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
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
import {
  type DiffContentCachePersistence,
  makeCompleteDiffReads
} from "../../src/server/application/completeDiffReads.js"
import type { PutContentResult } from "../../src/server/persistence/ContentStore.js"
import { PersistenceOperationError, ReproducibleContentUnavailableError } from "../../src/server/persistence/errors.js"
import { ContentBlobDigest } from "../../src/server/persistence/repositories/models.js"
import { PluginConflictFailure } from "../../src/server/plugins/failures.js"
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
    }),
  persistence?: DiffContentCachePersistence
) =>
  Crypto.Crypto.pipe(
    Effect.map((cryptoService) =>
      makeCompleteDiffReads(
        mapFor(connection),
        cryptoService,
        (scope) => lookup(scope.revision),
        persistence
      )
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
          "sha256:2e4905203b5018ac900b9b455578b8d1509fbc2ee0622eba98fc7e0703a7bbbe"
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

  it.effect("caches complete supported content and serves later bounded ranges without provider reads", () =>
    Effect.gen(function*() {
      const providerCalls = yield* Ref.make(0)
      const cacheDigest = yield* Ref.make(Option.none<typeof ContentBlobDigest.Type>())
      const cacheBytes = yield* Ref.make<Uint8Array<ArrayBufferLike>>(new Uint8Array())
      const putCalls = yield* Ref.make(0)
      const digest = ContentBlobDigest.make("a".repeat(64))
      const persistence: DiffContentCachePersistence = {
        diffContentCache: {
          get: () => Ref.get(cacheDigest),
          putContent: (_key, input) =>
            Effect.all([
              Ref.set(cacheDigest, Option.some(digest)),
              Ref.set(cacheBytes, input.bytes),
              Ref.update(putCalls, (count) => count + 1)
            ]).pipe(
              Effect.as(
                {
                  metadata: {
                    workspaceId,
                    digest,
                    storageClass: "reproducible-cache",
                    mimeType: input.mimeType,
                    byteLength: input.bytes.byteLength,
                    createdAt: input.createdAt,
                    lastVerifiedAt: null
                  },
                  stored: true
                } satisfies PutContentResult
              )
            )
        },
        content: {
          readAll: () => Ref.get(cacheBytes)
        }
      }
      const connection = baseConnection(Option.some<PluginDiffReaderV1>({
        readInventoryPage: () => Effect.die("unused"),
        readContentRange: (request) =>
          Ref.update(providerCalls, (count) => count + 1).pipe(
            Effect.as({
              bytesBase64: Encoding.encodeBase64(new TextEncoder().encode("abcdef")),
              totalBytes: 6,
              unavailableReason: null
            }),
            Effect.tap(() =>
              Effect.sync(() => {
                assert.strictEqual(request.offset, 0)
                assert.strictEqual(request.length, 1_048_576)
              })
            )
          )
      }))
      const reads = yield* makeReads(connection, undefined, persistence)
      const identity = {
        workspaceId,
        pluginConnectionId,
        vendorImmutableId,
        revision,
        anchor: DiffFileAnchor.make(
          "sha256:2e4905203b5018ac900b9b455578b8d1509fbc2ee0622eba98fc7e0703a7bbbe"
        ),
        path: PluginRelativePathV1.make("src/file.ts"),
        previousPath: null,
        status: modifiedStatus,
        side: "after",
        offset: 0,
        length: 1
      } satisfies Parameters<typeof reads.content>[0]
      const first = yield* reads.content({ ...identity, offset: 1, length: 3 })
      const second = yield* reads.content({ ...identity, offset: 2, length: 2 })
      const firstBytes = yield* Effect.fromResult(Encoding.decodeBase64(first.bytesBase64 ?? ""))
      const secondBytes = yield* Effect.fromResult(Encoding.decodeBase64(second.bytesBase64 ?? ""))

      assert.strictEqual(new TextDecoder().decode(firstBytes), "bcd")
      assert.strictEqual(new TextDecoder().decode(secondBytes), "cd")
      assert.strictEqual(yield* Ref.get(providerCalls), 1)
      assert.strictEqual(yield* Ref.get(putCalls), 1)
    }))

  it.effect("refetches and repairs a missing or corrupt reproducible cache object", () =>
    Effect.gen(function*() {
      const providerCalls = yield* Ref.make(0)
      const cacheDigest = yield* Ref.make(Option.some(ContentBlobDigest.make("b".repeat(64))))
      const broken = yield* Ref.make(true)
      const putCalls = yield* Ref.make(0)
      const digest = ContentBlobDigest.make("c".repeat(64))
      const persistence: DiffContentCachePersistence = {
        diffContentCache: {
          get: () => Ref.get(cacheDigest),
          putContent: (_key, input) =>
            Effect.all([
              Ref.set(cacheDigest, Option.some(digest)),
              Ref.set(broken, false),
              Ref.update(putCalls, (count) => count + 1)
            ]).pipe(
              Effect.as(
                {
                  metadata: {
                    workspaceId,
                    digest,
                    storageClass: "reproducible-cache",
                    mimeType: input.mimeType,
                    byteLength: input.bytes.byteLength,
                    createdAt: input.createdAt,
                    lastVerifiedAt: null
                  },
                  stored: true
                } satisfies PutContentResult
              )
            )
        },
        content: {
          readAll: () =>
            Ref.get(broken).pipe(
              Effect.flatMap((isBroken) =>
                isBroken
                  ? Effect.fail(
                    new ReproducibleContentUnavailableError({
                      workspaceId,
                      digest,
                      reason: "corrupt",
                      recovery: "refetch"
                    })
                  )
                  : Effect.succeed(new TextEncoder().encode("repaired"))
              )
            )
        }
      }
      const connection = baseConnection(Option.some<PluginDiffReaderV1>({
        readInventoryPage: () => Effect.die("unused"),
        readContentRange: () =>
          Ref.update(providerCalls, (count) => count + 1).pipe(
            Effect.as({
              bytesBase64: Encoding.encodeBase64(new TextEncoder().encode("repaired")),
              totalBytes: 8,
              unavailableReason: null
            })
          )
      }))
      const reads = yield* makeReads(connection, undefined, persistence)
      const content = yield* reads.content({
        workspaceId,
        pluginConnectionId,
        vendorImmutableId,
        revision,
        anchor: DiffFileAnchor.make(
          "sha256:2e4905203b5018ac900b9b455578b8d1509fbc2ee0622eba98fc7e0703a7bbbe"
        ),
        path: PluginRelativePathV1.make("src/file.ts"),
        previousPath: null,
        status: modifiedStatus,
        side: "after",
        offset: 0,
        length: 8
      })
      const contentBytes = yield* Effect.fromResult(Encoding.decodeBase64(content.bytesBase64 ?? ""))

      assert.strictEqual(new TextDecoder().decode(contentBytes), "repaired")
      assert.strictEqual(yield* Ref.get(providerCalls), 1)
      assert.strictEqual(yield* Ref.get(putCalls), 1)
      assert.isFalse(yield* Ref.get(broken))
    }))

  it.effect("serves healthy provider bytes when optional cache operations fail", () =>
    Effect.gen(function*() {
      const failureModes: ReadonlyArray<"cache-get" | "cache-put"> = [
        "cache-get",
        "cache-put"
      ]
      for (const failureMode of failureModes) {
        const providerCalls = yield* Ref.make(0)
        const digest = ContentBlobDigest.make("d".repeat(64))
        const persistenceFailure = new PersistenceOperationError({
          operation: `diff-cache-${failureMode}`
        })
        const persistence: DiffContentCachePersistence = {
          diffContentCache: {
            get: () =>
              failureMode === "cache-get"
                ? Effect.fail(persistenceFailure)
                : Effect.succeed(Option.none()),
            putContent: (_key, input) =>
              failureMode === "cache-put"
                ? Effect.fail(persistenceFailure)
                : Effect.succeed(
                  {
                    metadata: {
                      workspaceId,
                      digest,
                      storageClass: "reproducible-cache",
                      mimeType: input.mimeType,
                      byteLength: input.bytes.byteLength,
                      createdAt: input.createdAt,
                      lastVerifiedAt: null
                    },
                    stored: true
                  } satisfies PutContentResult
                )
          },
          content: {
            readAll: () => Effect.die("unused")
          }
        }
        const connection = baseConnection(Option.some<PluginDiffReaderV1>({
          readInventoryPage: () => Effect.die("unused"),
          readContentRange: () =>
            Ref.update(providerCalls, (count) => count + 1).pipe(
              Effect.as({
                bytesBase64: Encoding.encodeBase64(new TextEncoder().encode("provider")),
                totalBytes: 8,
                unavailableReason: null
              })
            )
        }))
        const reads = yield* makeReads(connection, undefined, persistence)
        const content = yield* reads.content({
          workspaceId,
          pluginConnectionId,
          vendorImmutableId,
          revision,
          anchor: DiffFileAnchor.make(
            "sha256:2e4905203b5018ac900b9b455578b8d1509fbc2ee0622eba98fc7e0703a7bbbe"
          ),
          path: PluginRelativePathV1.make("src/file.ts"),
          previousPath: null,
          status: modifiedStatus,
          side: "after",
          offset: 0,
          length: 8
        })
        const bytes = yield* Effect.fromResult(Encoding.decodeBase64(content.bytesBase64 ?? ""))

        assert.strictEqual(new TextDecoder().decode(bytes), "provider")
        assert.strictEqual(yield* Ref.get(providerCalls), 1)
      }
    }))

  it.effect("keeps file status in cache identity before provider fallback", () =>
    Effect.gen(function*() {
      const providerCalls = yield* Ref.make(0)
      const cacheStatuses = yield* Ref.make<ReadonlyArray<string>>([])
      const digest = ContentBlobDigest.make("e".repeat(64))
      const persistence: DiffContentCachePersistence = {
        diffContentCache: {
          get: (key) =>
            Ref.update(cacheStatuses, (statuses) => [...statuses, key.status]).pipe(
              Effect.as(
                key.status === modifiedStatus
                  ? Option.some(digest)
                  : Option.none()
              )
            ),
          putContent: () => Effect.die("unused")
        },
        content: {
          readAll: () => Effect.succeed(new TextEncoder().encode("cached"))
        }
      }
      const connection = baseConnection(Option.some<PluginDiffReaderV1>({
        readInventoryPage: () => Effect.die("unused"),
        readContentRange: () =>
          Ref.update(providerCalls, (count) => count + 1).pipe(
            Effect.andThen(
              Effect.fail(
                new PluginConflictFailure({
                  operation: "read-diff-content",
                  diagnosticCode: "status-mismatch"
                })
              )
            )
          )
      }))
      const reads = yield* makeReads(connection, undefined, persistence)
      const identity = {
        workspaceId,
        pluginConnectionId,
        vendorImmutableId,
        revision,
        anchor: DiffFileAnchor.make(
          "sha256:2e4905203b5018ac900b9b455578b8d1509fbc2ee0622eba98fc7e0703a7bbbe"
        ),
        path: PluginRelativePathV1.make("src/file.ts"),
        previousPath: null,
        status: modifiedStatus,
        side: "after",
        offset: 0,
        length: 6
      } satisfies Parameters<typeof reads.content>[0]

      const cached = yield* reads.content(identity)
      const mismatch = yield* reads.content({ ...identity, status: "deleted" }).pipe(Effect.result)
      const cachedBytes = yield* Effect.fromResult(Encoding.decodeBase64(cached.bytesBase64 ?? ""))

      assert.strictEqual(new TextDecoder().decode(cachedBytes), "cached")
      assert.strictEqual(mismatch._tag, "Failure")
      if (mismatch._tag === "Failure") assert.strictEqual(mismatch.failure._tag, "ApplicationConflict")
      assert.deepStrictEqual(yield* Ref.get(cacheStatuses), [modifiedStatus, "deleted"])
      assert.strictEqual(yield* Ref.get(providerCalls), 1)
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

  it.effect("keys stable SHA-256 anchors by immutable head and old/new paths", () =>
    Effect.gen(function*() {
      const headRevision = yield* Ref.make(Revision.make("head-commit"))
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
      const reads = yield* makeReads(
        connection,
        (requestedRevision) =>
          Ref.get(headRevision).pipe(
            Effect.map((resolvedHeadRevision) => ({
              revision: requestedRevision,
              baseRevision: Revision.make("base-commit"),
              headRevision: resolvedHeadRevision
            }))
          )
      )
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
        status: modifiedStatus
      }))
      const changedStatus = yield* inventoryFor(revision)
      yield* Ref.update(entry, (value) => ({
        ...value,
        path: PluginRelativePathV1.make("src/changed.ts")
      }))
      const changedPath = yield* inventoryFor(revision)
      yield* Ref.update(entry, (value) => ({
        ...value,
        previousPath: PluginRelativePathV1.make("src/another-previous.ts")
      }))
      const changedPreviousPath = yield* inventoryFor(revision)
      yield* Ref.set(entry, {
        path: PluginRelativePathV1.make("src/current.ts"),
        previousPath: PluginRelativePathV1.make("src/previous.ts"),
        status: "renamed",
        binary: false,
        generated: false,
        oversized: false
      })
      yield* Ref.set(headRevision, Revision.make("head-commit-2"))
      const changedHead = yield* inventoryFor(revision)
      const changedSourceRevision = yield* inventoryFor(Revision.make("revision-10"))
      const anchors = [
        initial.entries[0]?.anchor,
        changedPath.entries[0]?.anchor,
        changedPreviousPath.entries[0]?.anchor,
        changedHead.entries[0]?.anchor
      ]

      assert.strictEqual(initial.entries[0]?.anchor, repeated.entries[0]?.anchor)
      assert.strictEqual(initial.entries[0]?.anchor, changedStatus.entries[0]?.anchor)
      assert.strictEqual(changedHead.entries[0]?.anchor, changedSourceRevision.entries[0]?.anchor)
      assert.strictEqual(
        initial.entries[0]?.anchor,
        "sha256:5f3edcb5bd81d98f8b90a37fc566f1e747fd97a3c3730929c31fd9f1b2828be3"
      )
      assert.match(initial.entries[0]?.anchor ?? "", /^sha256:[0-9a-f]{64}$/u)
      assert.throws(() => Schema.decodeUnknownSync(DiffFileAnchor)("diff:legacy-anchor"))
      assert.strictEqual(new Set(anchors).size, anchors.length)
    }))

  it.effect("rejects an old-head anchor before reading cache or provider at the same source revision", () =>
    Effect.gen(function*() {
      const headRevision = yield* Ref.make(Revision.make("head-commit"))
      const cacheCalls = yield* Ref.make(0)
      const providerCalls = yield* Ref.make(0)
      const entry = {
        path: PluginRelativePathV1.make("src/file.ts"),
        previousPath: null,
        status: modifiedStatus,
        binary: false,
        generated: false,
        oversized: false
      } satisfies typeof PluginDiffInventoryEntryV1.Type
      const persistence: DiffContentCachePersistence = {
        diffContentCache: {
          get: () =>
            Ref.update(cacheCalls, (count) => count + 1).pipe(
              Effect.as(Option.none())
            ),
          putContent: () => Effect.die("unused")
        },
        content: {
          readAll: () => Effect.die("unused")
        }
      }
      const connection = baseConnection(Option.some<PluginDiffReaderV1>({
        readInventoryPage: () => Effect.succeed({ entries: [entry], nextCursor: null }),
        readContentRange: () =>
          Ref.update(providerCalls, (count) => count + 1).pipe(
            Effect.as(
              {
                bytesBase64: null,
                totalBytes: null,
                unavailableReason: "missing"
              } satisfies CompleteDiffContentRange
            )
          )
      }))
      const reads = yield* makeReads(
        connection,
        (requestedRevision) =>
          Ref.get(headRevision).pipe(
            Effect.map((resolvedHeadRevision) => ({
              revision: requestedRevision,
              baseRevision: Revision.make("base-commit"),
              headRevision: resolvedHeadRevision
            }))
          ),
        persistence
      )
      const initial = yield* reads.inventory({
        workspaceId,
        pluginConnectionId,
        vendorImmutableId,
        revision
      })
      const oldAnchor = initial.entries[0]?.anchor
      assert.isDefined(oldAnchor)

      yield* Ref.set(headRevision, Revision.make("head-commit-2"))
      const updated = yield* reads.inventory({
        workspaceId,
        pluginConnectionId,
        vendorImmutableId,
        revision
      })
      const result = yield* reads.content({
        workspaceId,
        pluginConnectionId,
        vendorImmutableId,
        revision,
        anchor: oldAnchor,
        path: entry.path,
        previousPath: entry.previousPath,
        status: entry.status,
        side: "after",
        offset: 0,
        length: 1
      }).pipe(Effect.result)

      assert.notStrictEqual(oldAnchor, updated.entries[0]?.anchor)
      assert.strictEqual(result._tag, "Failure")
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "ApplicationConflict")
      assert.strictEqual(yield* Ref.get(cacheCalls), 0)
      assert.strictEqual(yield* Ref.get(providerCalls), 0)
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
