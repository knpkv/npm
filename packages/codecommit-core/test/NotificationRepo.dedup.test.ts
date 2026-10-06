/** @effect-diagnostics strictEffectProvide:skip-file */

import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { DatabaseLive } from "../src/CacheService/Database.js"
import { NotificationRepo } from "../src/CacheService/repos/NotificationRepo.js"

const unreadSystemNotifications = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<{ title: string; message: string }>`
    SELECT title, message FROM notifications WHERE pull_request_id = '' AND read = 0 ORDER BY id
  `
})

const withRepo = <A, E>(
  body: Effect.Effect<A, E, NotificationRepo | SqlClient.SqlClient>
) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-notifications-" })
    const services = Layer.mergeAll(NotificationRepo.Default, DatabaseLive).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: root } })))
    )
    return yield* body.pipe(Effect.provide(services))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe("NotificationRepo.addSystem", () => {
  it.effect("deduplicates by profile, type and title, so one profile's different errors are all kept", () =>
    withRepo(Effect.gen(function*() {
      const repo = yield* NotificationRepo
      const error = { type: "error", profile: "alpha", deduplicate: true }
      yield* repo.addSystem({ ...error, title: "alpha (us-east-1)", message: "session expired" })
      yield* repo.addSystem({ ...error, title: "alpha (us-east-1)", message: "session expired" })
      yield* repo.addSystem({ ...error, title: "alpha (eu-west-1)", message: "session expired" })
      yield* repo.addSystem({ ...error, title: "alpha: approval evaluation", message: "1 pull request …" })
      expect((yield* unreadSystemNotifications).map(({ title }) => title)).toEqual([
        "alpha (us-east-1)",
        "alpha (eu-west-1)",
        "alpha: approval evaluation"
      ])
    })))

  it.effect("replaces the unread summary with the same title, so its count stays current", () =>
    withRepo(Effect.gen(function*() {
      const repo = yield* NotificationRepo
      const summary = { type: "error", profile: "alpha", title: "alpha: approval evaluation", replaceUnread: true }
      yield* repo.addSystem({ type: "error", profile: "alpha", title: "alpha (us-east-1)", message: "session expired" })
      yield* repo.addSystem({ ...summary, message: "1 pull request in us-east-1" })
      yield* repo.addSystem({ ...summary, message: "3 pull requests in us-east-1, eu-west-1" })
      expect(yield* unreadSystemNotifications).toEqual([
        { title: "alpha (us-east-1)", message: "session expired" },
        { title: "alpha: approval evaluation", message: "3 pull requests in us-east-1, eu-west-1" }
      ])
    })))
})
