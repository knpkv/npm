/** @effect-diagnostics strictEffectProvide:skip-file */

import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { DatabaseLive } from "../src/CacheService/Database.js"
import { SandboxRepo } from "../src/CacheService/repos/SandboxRepo.js"
import { SandboxId } from "../src/Domain.js"

describe("SandboxRepo legacy region lookup", () => {
  it.effect("finds rows written by the applied empty-string region migration", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-sandbox-repo-" })
      const services = Layer.mergeAll(SandboxRepo.Default, DatabaseLive).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: root } })))
      )

      yield* Effect.gen(function*() {
        const repo = yield* SandboxRepo
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO sandboxes (
          id, pull_request_id, aws_account_id, repository_name, region, source_branch,
          access_password, container_id, port, workspace_path, status, created_at, last_activity_at
        ) VALUES (
          'legacy', '42', '123', 'payments', '', 'feature',
          'protected', 'container', 18080, '/tmp/legacy', 'error',
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )`

        const rows = yield* repo.findRegionlessByPrAll("123", "42", "payments")
        expect(rows.map((row) => row.id)).toEqual(["legacy"])
        expect(rows[0]?.legacyRetiredAt).toBeNull()

        yield* repo.updateStatus(SandboxId.make("legacy"), "stopped", {
          legacyRetiredAt: "2026-08-31T00:00:00.000Z"
        })
        const retired = yield* repo.findById(SandboxId.make("legacy"))
        expect(retired.legacyRetiredAt).toBe("2026-08-31T00:00:00.000Z")
      }).pipe(Effect.provide(services), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer)))
})
