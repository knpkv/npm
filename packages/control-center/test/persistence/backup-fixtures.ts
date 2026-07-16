import { assert } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"

import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { createVerifiedBackup, decodePersistenceConfig, Persistence } from "../../src/server/persistence/index.js"
import { persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { fixtureTimestamps, fixtureWorkspaceIds } from "./fixtures.js"

const encoder = new TextEncoder()

export const makeEmptyVerifiedArchive = (prefix: string) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix })
    const sourceRoot = path.join(root, "source")
    yield* fileSystem.makeDirectory(sourceRoot, { mode: 0o700 })
    const sourceConfig = yield* decodePersistenceConfig({
      blobRoot: path.join(sourceRoot, "blobs"),
      busyTimeoutMilliseconds: 5_000,
      databaseUrl: `file:${path.join(sourceRoot, "control-center.db")}`,
      maxConnections: 1
    })
    const archiveRoot = path.join(root, "archive")
    yield* Effect.gen(function*() {
      const database = yield* Database
      yield* createVerifiedBackup({
        destination: archiveRoot,
        persistenceConfig: sourceConfig,
        sql: database.sql
      })
    }).pipe(Effect.provide(databaseLayer(sourceConfig)), Effect.scoped)
    return { archiveRoot, root, sourceConfig }
  })

export const makeContentVerifiedArchive = (prefix: string) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix })
    const sourceConfig = yield* decodePersistenceConfig({
      blobRoot: path.join(root, "blobs"),
      busyTimeoutMilliseconds: 5_000,
      databaseUrl: `file:${path.join(root, "control-center.db")}`,
      maxConnections: 1
    })
    const archiveRoot = path.join(root, "archive")
    const services = persistenceLayerFromDatabase(sourceConfig).pipe(Layer.provideMerge(databaseLayer(sourceConfig)))
    const digests = yield* Effect.gen(function*() {
      const persistence = yield* Persistence
      const database = yield* Database
      yield* persistence.workspaces.create(fixtureWorkspaceIds.alpha, {
        createdAt: fixtureTimestamps.created,
        displayName: WorkspaceName.make("Payments")
      })
      const durable = yield* persistence.content.put(fixtureWorkspaceIds.alpha, {
        bytes: encoder.encode("authoritative release evidence"),
        classification: "durable",
        createdAt: fixtureTimestamps.created,
        mimeType: "text/plain"
      })
      const cache = yield* persistence.content.put(fixtureWorkspaceIds.alpha, {
        bytes: encoder.encode("reproducible provider cache"),
        classification: "reproducible-cache",
        createdAt: fixtureTimestamps.created,
        mimeType: "text/plain"
      })
      yield* createVerifiedBackup({
        destination: archiveRoot,
        persistenceConfig: sourceConfig,
        sql: database.sql
      })
      return { cache: cache.metadata.digest, durable: durable.metadata.digest }
    }).pipe(Effect.provide(services), Effect.scoped)
    return { archiveRoot, digests, root, sourceConfig }
  })

export const stagingEntries = (
  fileSystem: FileSystem.FileSystem,
  root: string,
  prefix: ".control-center-backup-incoming-" | ".control-center-incoming-"
) => fileSystem.readDirectory(root).pipe(Effect.map((entries) => entries.filter((entry) => entry.startsWith(prefix))))

export const assertOwnerOnlyTree = (root: string) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const pending = [root]
    while (pending.length > 0) {
      const directory = pending.pop()
      if (directory === undefined) continue
      assert.strictEqual((yield* fileSystem.stat(directory)).mode & 0o777, 0o700)
      for (const entry of yield* fileSystem.readDirectory(directory)) {
        const child = path.join(directory, entry)
        const info = yield* fileSystem.stat(child)
        if (info.type === "Directory") pending.push(child)
        else {
          assert.strictEqual(info.type, "File")
          assert.strictEqual(info.mode & 0o777, 0o600)
        }
      }
    }
  })
