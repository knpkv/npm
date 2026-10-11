import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { DatabaseLive } from "@knpkv/codecommit-core/CacheService/Database.js"
import { ConfigProvider, Context, Effect, FileSystem, Layer, Logger, Ref, Result, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as TestClock from "effect/testing/TestClock"
import { type CodeQueueQuery, CodeReference } from "../src/host-contract.js"
import { CodeHostReadError, type CodeReferenceStore } from "../src/server/host-model.js"
import { makeCodeHostReads } from "../src/server/host-read.js"

const references: CodeReferenceStore = {
  reference: () => Effect.succeed(Schema.decodeUnknownSync(CodeReference)("00000000-0000-4000-8000-000000000001")),
  resolve: () => Effect.succeed(null)
}
const query = { filter: "open", search: "", offset: 0 } satisfies CodeQueueQuery
const services = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)

const createOwner = (home: string, id: string) =>
  Effect.gen(function*() {
    const context = yield* Layer.build(DatabaseLive.pipe(Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } }))
    )))
    const sql = Context.get(context, SqlClient.SqlClient)
    yield* sql`INSERT INTO pull_requests (
    id, aws_account_id, account_profile, account_region, title, author, repository_name,
    creation_date, last_modified_date, approval_version, status, source_branch, destination_branch, link, fetched_at
  ) VALUES (${id}, ${"1".repeat(12)}, 'fixture', 'example-region', ${`Cached ${id}`}, 'example-author', 'example',
    '2026-10-11T00:00:00Z', '2026-10-11T00:00:00Z', '2026-10-11T00:00:00Z', 'OPEN', 'feature', 'main', '', '2026-10-11T00:00:00Z')`
  }).pipe(Effect.scoped)

it.layer(services)("Code owner cache attachment lifetime", (it) => {
  /** A failed replacement lookup must retain its negative TTL rather than retrying every phone poll. */
  it.effect("spaces invalid replacement attachment attempts by two seconds", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "code-owner-invalid-" })
      yield* createOwner(home, "7")
      const messages: Array<unknown> = []
      const logger = Logger.make<unknown, void>((entry) => {
        if (Array.isArray(entry.message) && entry.message.includes("Code host cache is unavailable")) {
          messages.push(entry.message)
        }
      })
      yield* Effect.gen(function*() {
        const reads = yield* makeCodeHostReads(Effect.succeed(references))
        yield* reads.queue(query)
        yield* fs.rename(`${home}/.codecommit`, `${home}/old-cache`)
        // The owner has not yet created a replacement. First retire, then attempt one reattach.
        expect(Result.isFailure(yield* Effect.result(reads.queue(query)))).toBe(true)
        expect(Result.isFailure(yield* Effect.result(reads.queue(query)))).toBe(true)
        const attempts = messages.length
        expect(attempts).toBeGreaterThan(0)
        yield* Effect.result(reads.queue(query))
        expect(messages.length).toBe(attempts)
        yield* TestClock.adjust("1 second")
        yield* Effect.result(reads.queue(query))
        expect(messages.length).toBe(attempts)
        yield* TestClock.adjust("1100 millis")
        yield* Effect.result(reads.queue(query))
        expect(messages.length).toBeGreaterThan(attempts)
      }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { HOME: home } })),
        Effect.withLogger(logger)
      )
    }))

  /** An owner cache replacement must retire old handles and never keep serving unlinked rows. */
  it.effect("reattaches after the owner replaces its cache", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "code-owner-replace-" })
      const replacement = yield* fs.makeTempDirectoryScoped({ prefix: "code-owner-new-" })
      yield* createOwner(home, "7")
      yield* createOwner(replacement, "8")
      yield* Effect.gen(function*() {
        const reads = yield* makeCodeHostReads(Effect.succeed(references))
        const initial = yield* reads.queue(query)
        if (initial._tag === "Ready") expect(initial.items.map((item) => item.id)).toEqual(["7"])
        else expect.fail("Initial cache did not attach")
        yield* fs.rename(`${home}/.codecommit`, `${home}/old-cache`)
        yield* fs.rename(`${replacement}/.codecommit`, `${home}/.codecommit`)
        const retired = yield* Effect.result(reads.queue(query))
        expect(Result.isFailure(retired)).toBe(true)
        if (Result.isFailure(retired)) expect(retired.failure.reason).toBe("cache_unavailable")
        const current = yield* reads.queue(query)
        if (current._tag === "Ready") expect(current.items.map((item) => item.id)).toEqual(["8"])
        else expect.fail("Replacement cache did not attach")
      }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { HOME: home } })))
    }))

  /** The owner may start or finish its migration after the hub has already started. */
  it.effect("recovers from a missing owner cache without rebuilding the host service", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "code-owner-recovery-" })
      const acquisitions = yield* Ref.make(0)
      yield* Effect.gen(function*() {
        const reads = yield* makeCodeHostReads(Ref.update(acquisitions, (n) => n + 1).pipe(Effect.as(references)))
        const missing = yield* Effect.result(reads.queue(query))
        expect(Result.isFailure(missing)).toBe(true)
        if (Result.isFailure(missing)) expect(missing.failure.reason).toBe("cache_unavailable")
        expect(yield* fs.exists(`${home}/.codecommit/cache.db`)).toBe(false)
        expect(yield* Ref.get(acquisitions)).toBe(0)
        yield* Effect.scoped(Layer.build(DatabaseLive))
        yield* TestClock.adjust("3 seconds")
        const ready = yield* reads.queue(query)
        expect(ready).toMatchObject({ _tag: "Ready", items: [] })
        yield* reads.queue(query)
        expect(yield* Ref.get(acquisitions)).toBe(1)
      }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { HOME: home } })))
    }))

  /** A private reference store failure must not masquerade as an owner cache problem. */
  it.effect("classifies and logs a failed reference attachment separately", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "code-reference-failure-" })
      const messages: Array<unknown> = []
      const logger = Logger.make<unknown, void>((entry) => messages.push(entry.message))
      yield* Effect.gen(function*() {
        yield* Effect.scoped(Layer.build(DatabaseLive))
        const cause = new CodeHostReadError({ reason: "unavailable" })
        const reads = yield* makeCodeHostReads(Effect.fail(cause))
        const failure = yield* Effect.result(reads.queue(query))
        expect(Result.isFailure(failure)).toBe(true)
        if (Result.isFailure(failure)) expect(failure.failure.reason).toBe("unavailable")
        expect(messages).toContainEqual(["Code reference store is unavailable", cause])
      }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { HOME: home } })),
        Effect.withLogger(logger)
      )
    }))
})
