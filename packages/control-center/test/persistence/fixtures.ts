import { Effect, FileSystem, Schema } from "effect"

import { WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"

/** Deterministic workspace identities shared by persistence integration suites. */
export const fixtureWorkspaceIds = {
  alpha: Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000021"),
  beta: Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000022"),
  missing: Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000023")
}

/** Deterministic observation times shared by persistence integration suites. */
export const fixtureTimestamps = {
  created: Schema.decodeSync(UtcTimestamp)("2026-07-13T10:00:00.000Z"),
  verifiedEarlier: Schema.decodeSync(UtcTimestamp)("2026-07-13T10:05:00.000Z"),
  verifiedLater: Schema.decodeSync(UtcTimestamp)("2026-07-13T10:10:00.000Z")
}

/** Create isolated local persistence configuration with scoped teardown. */
export const makePersistenceTestConfig = (prefix: string) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix })
    return {
      blobRoot: `${root}/blobs`,
      busyTimeoutMilliseconds: 5_000,
      databaseUrl: `file:${root}/control-center.db`,
      maxConnections: 1
    }
  })
