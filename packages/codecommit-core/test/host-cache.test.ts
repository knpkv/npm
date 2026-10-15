import { NodeServices } from "@effect/platform-node"
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import { describe, expect, it } from "@effect/vitest"
import { Clock, ConfigProvider, Context, Effect, Layer, Option, Result, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as SqlClient from "effect/sql/SqlClient"
import { DatabaseLive } from "../src/CacheService/Database.js"
import { attachHostCache } from "../src/CacheService/HostReads.js"
import { ensurePrivateDatabasePath } from "../src/CacheService/internal/PrivateDatabasePathNode.js"
import { CommentRepo } from "../src/CacheService/repos/CommentRepo.js"
import { CommentId, type CommentThreadJsonEncoded, PRComment, type PRCommentLocation } from "../src/Domain.js"
import type { NewAuditLogEntry } from "../src/PermissionService/AuditLog.js"

const fixture = <A, E, R>(run: (database: string, sql: LibsqlClient.LibsqlClient) => Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const services = yield* Layer.build(Layer.merge(Reactivity.layer, NodeServices.layer))
    return yield* Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "code-host-cache-" })
      const database = `${directory}/cache.db`
      yield* ensurePrivateDatabasePath(directory, database)
      const sql = yield* LibsqlClient.make({ url: `file:${database}` })
      yield* sql`CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY)`
      yield* sql`CREATE TABLE audit_log (timestamp TEXT, operation TEXT, account_profile TEXT, region TEXT, permission_state TEXT, context TEXT, duration_ms REAL)`
      for (let id = 1; id <= 25; id++) yield* sql`INSERT INTO effect_sql_migrations VALUES (${id})`
      return yield* run(database, sql)
    }).pipe(Effect.provideContext(services))
  })

const entry = {
  timestamp: "2026-10-11T00:00:00Z",
  operation: "getBlob",
  accountProfile: "fixture",
  region: "us-east-1",
  permissionState: "always_allowed",
  context: "hub:example-viewer Read blob",
  durationMs: null
} satisfies NewAuditLogEntry

describe("host cache attachment", () => {
  /** Attaching must never migrate an older or future owner's schema. */
  it.effect("accepts only the exact known migration set", () =>
    fixture((database, sql) =>
      Effect.gen(function*() {
        yield* attachHostCache(database)
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 25`
        expect(Result.isFailure(yield* Effect.result(attachHostCache(database)))).toBe(true)
        yield* sql`INSERT INTO effect_sql_migrations VALUES (25), (26)`
        expect(Result.isFailure(yield* Effect.result(attachHostCache(database)))).toBe(true)
        expect((yield* sql`SELECT migration_id FROM effect_sql_migrations`).length).toBe(26)
      })
    ))

  /** A concurrently upgraded owner must prevent the next audit, hence the next provider call. */
  it.effect("checks schema again in each audit transaction", () =>
    fixture((database, sql) =>
      Effect.gen(function*() {
        const cache = yield* attachHostCache(database)
        yield* cache.log(entry)
        yield* sql`INSERT INTO effect_sql_migrations VALUES (26)`
        expect(Result.isFailure(yield* Effect.result(cache.log(entry)))).toBe(true)
        expect((yield* sql`SELECT * FROM audit_log`).length).toBe(1)
      })
    ))

  it.effect("refuses an audit while another connection holds the writer lock", () =>
    fixture((database, sql) =>
      Effect.gen(function*() {
        const cache = yield* attachHostCache(database)
        yield* sql.withTransaction(Effect.gen(function*() {
          yield* sql`INSERT INTO audit_log VALUES ('lock', 'lock', 'fixture', 'fixture', 'allowed', 'lock', NULL)`
          const outcome = yield* Effect.result(cache.log(entry))
          expect(Result.isFailure(outcome)).toBe(true)
          if (Result.isFailure(outcome)) expect(outcome.failure._tag).toBe("CacheError")
        }))
        expect((yield* sql`SELECT * FROM audit_log`).length).toBe(1)
      })
    ))

  /** Native SQLite contention must use the configured timeout on transaction-pool connections too. */
  it.live("waits for a short external lock and bounds a long one", () =>
    fixture((database) =>
      Effect.gen(function*() {
        const cache = yield* attachHostCache(database)
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const holdLock = (milliseconds: number) =>
          spawner.spawn(ChildProcess.make("node", [
            "--input-type=module",
            "-e",
            `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      console.log('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, Number(process.argv[2]));
    `,
            database,
            String(milliseconds)
          ], { extendEnv: true }))
        const short = yield* holdLock(200)
        yield* short.stdout.pipe(Stream.decodeText(), Stream.take(1), Stream.runCollect)
        yield* cache.log(entry)
        expect(yield* short.exitCode).toBe(0)
        const long = yield* holdLock(2000)
        yield* long.stdout.pipe(Stream.decodeText(), Stream.take(1), Stream.runCollect)
        const started = yield* Clock.currentTimeMillis
        expect(Result.isFailure(yield* Effect.result(cache.log(entry)))).toBe(true)
        const duration = (yield* Clock.currentTimeMillis) - started
        expect(duration).toBeGreaterThanOrEqual(350)
        expect(duration).toBeLessThan(1500)
      })
    ))
})

const coordinates = { accountId: "owner-account", region: "fixture-zone", repository: "review-repo", id: "42" }
const commentLocations = [{
  comments: [{
    root: {
      id: "comment-one",
      content: "Review this branch",
      author: "Reviewer",
      creationDate: "2026-10-13T12:00:00.000Z",
      deleted: false
    },
    replies: []
  }]
}]
const commentFixture = <A, E, R>(run: Parameters<typeof fixture<A, E, R>>[0]) =>
  fixture((database, sql) =>
    Effect.gen(function*() {
      yield* sql`CREATE TABLE pull_requests (aws_account_id TEXT, id TEXT, repository_name TEXT, account_region TEXT)`
      yield* sql`CREATE TABLE pr_comments (aws_account_id TEXT, pull_request_id TEXT, repository_name TEXT, account_region TEXT, locations_json TEXT, fetched_at TEXT)`
      return yield* run(database, sql)
    })
  )

const replyChain = (levels: number): CommentThreadJsonEncoded => {
  const root = {
    id: "reply",
    content: "Reviewer reply",
    author: "Reviewer",
    creationDate: "2026-10-13T12:00:00Z",
    deleted: false
  }
  let thread: CommentThreadJsonEncoded = { root, replies: [] }
  for (let level = 0; level < levels; level++) thread = { root: { ...root, id: `reply-${level}` }, replies: [thread] }
  return thread
}

describe("host cached comments", () => {
  it.effect("accepts ordinary reply chains and distinguishes valid larger owner snapshots from corruption", () =>
    commentFixture((database, sql) =>
      Effect.gen(function*() {
        const cache = yield* attachHostCache(database)
        const ordinary = [{ comments: [replyChain(15)] }]
        yield* sql`INSERT INTO pr_comments VALUES ('owner-account', '42', 'review-repo', 'fixture-zone', ${
          JSON.stringify(ordinary)
        }, '2026-10-13 12:00:00')`
        expect((yield* cache.comments(coordinates))?.locations).toEqual(ordinary)
        for (
          const locations of [Array.from({ length: 501 }, () => ({ comments: [] })), [{ comments: [replyChain(65)] }]]
        ) {
          yield* sql`UPDATE pr_comments SET locations_json = ${JSON.stringify(locations)}`
          const result = yield* Effect.result(cache.comments(coordinates))
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) {
            expect(result.failure).toMatchObject({ _tag: "HostCommentsReadError", reason: "over_limit" })
          }
        }
        yield* sql`UPDATE pr_comments SET locations_json = 'not-json'`
        const corrupt = yield* Effect.result(cache.comments(coordinates))
        expect(Result.isFailure(corrupt)).toBe(true)
        if (Result.isFailure(corrupt)) {
          expect(corrupt.failure).toMatchObject({ _tag: "HostCommentsReadError", reason: "corrupt" })
        }
      })
    ))

  it.effect("uses the owner's coordinate predicate through both real readers", () =>
    Effect.gen(function*() {
      const services = yield* Layer.build(NodeServices.layer)
      return yield* Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "code-comments-owner-" })
        const context = yield* Layer.build(
          Layer.merge(CommentRepo.Default, DatabaseLive).pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: root })))
          )
        )
        const sql = Context.get(context, SqlClient.SqlClient)
        const repo = Context.get(context, CommentRepo)
        const cache = yield* attachHostCache(`${root}/.codecommit/cache.db`)
        yield* repo.upsert(coordinates.accountId, coordinates.id, JSON.stringify(commentLocations))
        const check = (present: boolean) =>
          Effect.gen(function*() {
            const owner = yield* repo.find(coordinates.accountId, coordinates.id, {
              repositoryName: coordinates.repository,
              accountRegion: coordinates.region
            })
            expect(Option.isSome(owner)).toBe(present)
            expect((yield* cache.comments(coordinates)) !== null).toBe(present)
          })
        yield* check(false)
        yield* sql`INSERT INTO pull_requests (
          id, aws_account_id, account_profile, account_region, title, author, repository_name,
          creation_date, last_modified_date, status, source_branch, destination_branch, link
        ) VALUES ('42', 'owner-account', 'Owner', 'fixture-zone', 'Review', 'Author', 'another-repo',
          '2026-10-13T12:00:00Z', '2026-10-13T12:00:00Z', 'OPEN', 'feature', 'main', 'https://example.invalid/pr/42')`
        yield* check(false)
        yield* sql`UPDATE pull_requests SET repository_name = 'review-repo'`
        yield* check(true)
        yield* sql`INSERT INTO pull_requests (
          id, aws_account_id, account_profile, account_region, title, author, repository_name,
          creation_date, last_modified_date, status, source_branch, destination_branch, link
        ) VALUES ('42', 'owner-account', 'Owner', 'another-zone', 'Review', 'Author', 'review-repo',
          '2026-10-13T12:00:00Z', '2026-10-13T12:00:00Z', 'OPEN', 'feature', 'main', 'https://example.invalid/pr/42')`
        yield* check(false)
        yield* repo.upsert(coordinates.accountId, coordinates.id, "[]", {
          repositoryName: coordinates.repository,
          accountRegion: coordinates.region
        })
        yield* check(true)
        const owner = yield* repo.find(coordinates.accountId, coordinates.id, {
          repositoryName: coordinates.repository,
          accountRegion: coordinates.region
        })
        expect(Option.getOrNull(owner)).toEqual([])
        expect((yield* cache.comments(coordinates))?.locations).toEqual([])
        const written: ReadonlyArray<PRCommentLocation> = [{
          filePath: "src/review.ts",
          beforeCommitId: "base-one",
          afterCommitId: "head-one",
          relativeFileVersion: "AFTER",
          comments: [{
            root: new PRComment({
              id: CommentId.make("comment-one"),
              inReplyTo: CommentId.make("parent-comment"),
              filePath: "src/review.ts",
              lineNumber: 9,
              content: "Review this branch",
              author: "Reviewer",
              creationDate: new Date("2026-10-13T12:00:00Z"),
              deleted: false
            }),
            replies: []
          }]
        }]
        yield* repo.upsert(coordinates.accountId, coordinates.id, JSON.stringify(written), {
          repositoryName: coordinates.repository,
          accountRegion: coordinates.region
        })
        const roundTrip = yield* cache.comments(coordinates)
        expect(roundTrip?.locations[0]?.comments[0]?.root).toMatchObject({
          id: "comment-one",
          inReplyTo: "parent-comment",
          filePath: "src/review.ts",
          lineNumber: 9,
          creationDate: "2026-10-13T12:00:00.000Z"
        })
      }).pipe(Effect.provideContext(services))
    }))

  it.effect("distinguishes a missing snapshot from a cached empty conversation", () =>
    commentFixture((database, sql) =>
      Effect.gen(function*() {
        const cache = yield* attachHostCache(database)
        expect(yield* cache.comments(coordinates)).toBeNull()
        yield* sql`INSERT INTO pr_comments VALUES ('owner-account', '42', 'review-repo', 'fixture-zone', '[]', '2026-10-13 12:00:00')`
        expect(yield* cache.comments(coordinates)).toEqual({ observedAt: 1791892800000, locations: [] })
        expect(yield* sql`SELECT * FROM audit_log`).toHaveLength(0)
        expect(Object.keys(cache).sort()).toEqual(["comments", "exact", "log", "queue"])
      })
    ))

  it.effect("reads only the exact account, region, repository and PR", () =>
    commentFixture((database, sql) =>
      Effect.gen(function*() {
        yield* sql`INSERT INTO pr_comments VALUES ('owner-account', '42', 'review-repo', 'fixture-zone', ${
          JSON.stringify(commentLocations)
        }, '2026-10-13 12:00:00')`
        const cache = yield* attachHostCache(database)
        expect((yield* cache.comments(coordinates))?.locations).toEqual(commentLocations)
        for (
          const other of [
            { ...coordinates, accountId: "another-account" },
            { ...coordinates, region: "another-zone" },
            { ...coordinates, repository: "another-repo" },
            { ...coordinates, id: "43" }
          ]
        ) expect(yield* cache.comments(other)).toBeNull()
        expect(yield* sql`SELECT * FROM pr_comments`).toHaveLength(1)
      })
    ))

  it.effect("adopts legacy comments only for the unique exact cached PR, preferring an exact snapshot", () =>
    commentFixture((database, sql) =>
      Effect.gen(function*() {
        yield* sql`INSERT INTO pr_comments VALUES ('owner-account', '42', '', '', ${
          JSON.stringify(commentLocations)
        }, '2026-10-13 12:00:00')`
        const cache = yield* attachHostCache(database)
        expect(yield* cache.comments(coordinates)).toBeNull()
        yield* sql`INSERT INTO pull_requests VALUES ('owner-account', '42', 'another-repo', 'fixture-zone')`
        expect(yield* cache.comments(coordinates)).toBeNull()
        yield* sql`UPDATE pull_requests SET repository_name = 'review-repo'`
        expect((yield* cache.comments(coordinates))?.locations).toEqual(commentLocations)
        yield* sql`INSERT INTO pull_requests VALUES ('owner-account', '42', 'another-repo', 'fixture-zone')`
        expect(yield* cache.comments(coordinates)).toBeNull()
        yield* sql`INSERT INTO pr_comments VALUES ('owner-account', '42', 'review-repo', 'fixture-zone', '[]', '2026-10-13 12:01:00')`
        expect((yield* cache.comments(coordinates))?.locations).toEqual([])
      })
    ))

  it.effect("refuses corrupt, excess-property and invalid-timestamp snapshots instead of reporting no comments", () =>
    commentFixture((database, sql) =>
      Effect.gen(function*() {
        const cache = yield* attachHostCache(database)
        for (const json of ["broken", "{}", JSON.stringify([{ ...commentLocations[0], token: "never-emitted" }])]) {
          yield* sql`DELETE FROM pr_comments`
          yield* sql`INSERT INTO pr_comments VALUES ('owner-account', '42', 'review-repo', 'fixture-zone', ${json}, '2026-10-13 12:00:00')`
          const result = yield* Effect.result(cache.comments(coordinates))
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) {
            expect(result.failure).toMatchObject({ _tag: "HostCommentsReadError", reason: "corrupt" })
          }
        }
        yield* sql`UPDATE pr_comments SET locations_json = '[]', fetched_at = 'not-a-time'`
        expect(Result.isFailure(yield* Effect.result(cache.comments(coordinates)))).toBe(true)
      })
    ))

  it.effect("bounds stored bytes and recursive nesting before decoding comment threads", () =>
    commentFixture((database, sql) =>
      Effect.gen(function*() {
        const cache = yield* attachHostCache(database)
        for (const json of [JSON.stringify("x".repeat(1_048_576)), "[".repeat(1000) + "0" + "]".repeat(1000)]) {
          yield* sql`DELETE FROM pr_comments`
          yield* sql`INSERT INTO pr_comments VALUES ('owner-account', '42', 'review-repo', 'fixture-zone', ${json}, '2026-10-13 12:00:00')`
          const result = yield* Effect.result(cache.comments(coordinates))
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) {
            expect(result.failure).toMatchObject({ _tag: "HostCommentsReadError", reason: "over_limit" })
          }
        }
      })
    ))
})
