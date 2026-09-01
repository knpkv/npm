/** @effect-diagnostics strictEffectProvide:skip-file */

import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { DatabaseLive } from "../src/CacheService/Database.js"
import { SubscriptionRepo } from "../src/CacheService/repos/SubscriptionRepo.js"

describe("SubscriptionRepo coordinate migration", () => {
  it.effect("removes an adopted legacy subscription for its unique exact PR", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-subscriptions-" })
      const services = Layer.mergeAll(SubscriptionRepo.Default, DatabaseLive).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: root } })))
      )

      yield* Effect.gen(function*() {
        const repo = yield* SubscriptionRepo
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO pull_requests (
          id, aws_account_id, account_profile, account_region, title, author,
          repository_name, creation_date, last_modified_date, status,
          source_branch, destination_branch, link
        ) VALUES (
          '42', '123', 'profile', 'eu-west-1', 'Review', 'author',
          'payments', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'OPEN',
          'feature', 'main', 'https://example.invalid/pr/42'
        )`
        yield* repo.subscribe("123", "42")
        yield* repo.unsubscribe("123", "42", { repositoryName: "payments", accountRegion: "eu-west-1" })
        expect(yield* repo.isSubscribed("123", "42", { repositoryName: "payments", accountRegion: "eu-west-1" }))
          .toBe(false)

        yield* repo.subscribe("123", "42")
        yield* sql`INSERT INTO pull_requests (
          id, aws_account_id, account_profile, account_region, title, author,
          repository_name, creation_date, last_modified_date, status,
          source_branch, destination_branch, link
        ) VALUES (
          '42', '123', 'profile', 'us-east-1', 'Review elsewhere', 'author',
          'orders', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'OPEN',
          'feature', 'main', 'https://example.invalid/pr/42-orders'
        )`
        expect(
          yield* repo.isSubscribed("123", "42", { repositoryName: "payments", accountRegion: "eu-west-1" })
        ).toBe(false)
        yield* repo.unsubscribe("123", "42", { repositoryName: "payments", accountRegion: "eu-west-1" })
        expect(yield* repo.isSubscribed("123", "42")).toBe(true)
      }).pipe(Effect.provide(services), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer)))
})
