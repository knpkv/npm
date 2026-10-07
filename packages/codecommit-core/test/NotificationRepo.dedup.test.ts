/** @effect-diagnostics strictEffectProvide:skip-file */

import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { DatabaseLive } from "../src/CacheService/Database.js"
import { NotificationRepo } from "../src/CacheService/repos/NotificationRepo.js"

const unreadSystemNotifications = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<{ id: number; title: string; message: string }>`
    SELECT id, title, message FROM notifications WHERE pull_request_id = '' AND read = 0 ORDER BY id
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
      expect((yield* unreadSystemNotifications).map(({ message, title }) => ({ title, message }))).toEqual([
        { title: "alpha (us-east-1)", message: "session expired" },
        { title: "alpha: approval evaluation", message: "3 pull requests in us-east-1, eu-west-1" }
      ])
    })))

  it.effect("keeps the unread summary when its replacement cannot be written", () =>
    withRepo(Effect.gen(function*() {
      const repo = yield* NotificationRepo
      const sql = yield* SqlClient.SqlClient
      const summary = { type: "error", profile: "alpha", title: "alpha: approval evaluation", replaceUnread: true }
      yield* repo.addSystem({ ...summary, message: "1 pull request in us-east-1" })
      yield* sql`
        CREATE TRIGGER reject_replacement BEFORE UPDATE ON notifications
        WHEN NEW.message = 'rejected' BEGIN SELECT RAISE(ABORT, 'rejected'); END
      `
      const exit = yield* Effect.exit(repo.addSystem({ ...summary, message: "rejected" }))
      expect(exit._tag).toBe("Failure")
      expect((yield* unreadSystemNotifications).map(({ message, title }) => ({ title, message }))).toEqual([
        { title: "alpha: approval evaluation", message: "1 pull request in us-east-1" }
      ])
    })))

  it.effect("keeps one id for an unread summary: unchanged is untouched, a new count updates it in place", () =>
    withRepo(Effect.gen(function*() {
      const repo = yield* NotificationRepo
      const summary = { type: "error", profile: "alpha", title: "alpha: approval evaluation", replaceUnread: true }
      yield* repo.addSystem({ ...summary, message: "1 pull request in us-east-1" })
      const [first] = yield* unreadSystemNotifications
      yield* repo.addSystem({ ...summary, message: "1 pull request in us-east-1" })
      yield* repo.addSystem({ ...summary, message: "2 pull requests in us-east-1" })
      expect(yield* unreadSystemNotifications).toEqual([
        { id: first?.id, title: "alpha: approval evaluation", message: "2 pull requests in us-east-1" }
      ])

      // Once read, a later failure is news again.
      yield* repo.markRead(first?.id ?? -1)
      yield* repo.addSystem({ ...summary, message: "2 pull requests in us-east-1" })
      const [next] = yield* unreadSystemNotifications
      expect(next?.id).toBeGreaterThan(first?.id ?? 0)
    })))
})

describe("NotificationRepo.add", () => {
  // A restart re-diffs every subscribed pull request against the cache. An announcement already
  // waiting unread must not be added again; once read, a new one may be.
  it.effect("keeps one unread copy of the same pull-request notification across repeated diffs", () =>
    withRepo(Effect.gen(function*() {
      const repo = yield* NotificationRepo
      const sql = yield* SqlClient.SqlClient
      const granted = {
        pullRequestId: "44",
        awsAccountId: "123456789012",
        type: "approval_changed",
        message: "Approval granted on #44 Fix (repo)",
        title: "Fix",
        profile: "dev",
        repositoryName: "repo",
        accountRegion: "eu-central-1"
      }
      const prRows = sql<{ id: number; read: number }>`
        SELECT id, read FROM notifications WHERE pull_request_id = '44' ORDER BY id
      `
      yield* repo.add(granted)
      yield* repo.add(granted)
      // The same text for another region's pull request is a different notification.
      yield* repo.add({ ...granted, accountRegion: "us-east-1" })
      expect((yield* prRows).length).toBe(2)
      yield* repo.markAllRead()
      yield* repo.add(granted)
      expect((yield* prRows).length).toBe(3)
    })))
})
