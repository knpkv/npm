/**
 * Every write to a pull-request row is a compare-and-set per column group: the row, and the approval
 * (approval, unknown reason, rules), each with its own version (provider last activity, observation
 * number), compared in that order. A write observed at an older version than a group's leaves that
 * group alone. The table runs every writer pair, newer first and older second, and expects every group
 * the newer write touched exactly as it left it; a group only the older write touches may still move.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer, Option, Predicate, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { DatabaseLive } from "../src/CacheService/Database.js"
import {
  CachedPullRequest,
  PullRequestRepo,
  type PullRequestRepoContract,
  type RowVersion,
  type RowVersions,
  UpsertInput,
  versionsOf
} from "../src/CacheService/repos/PullRequestRepo/index.js"

const account = "123456789012"
const coordinates = { repositoryName: "payments", accountRegion: "eu-west-1" }
const t0 = new Date("2026-10-01T00:00:00.000Z")
const older = new Date("2026-10-02T00:00:00.000Z")
const newer = new Date("2026-10-03T00:00:00.000Z")
const newest = new Date("2026-10-04T00:00:00.000Z")

const rule = (satisfied: boolean) => ({
  ruleName: "two-reviewers",
  requiredApprovals: 2,
  poolMembers: ["alice"],
  poolMemberArns: [],
  satisfied
})

type Tag = "seed" | "older" | "newer" | "newest"

const listed = (lastActivity: Date, tag: Tag) =>
  Schema.decodeSync(UpsertInput)({
    id: "60",
    awsAccountId: account,
    repoAccountId: null,
    accountProfile: "production",
    accountRegion: coordinates.accountRegion,
    title: `PR ${tag}`,
    description: null,
    author: "author",
    repositoryName: coordinates.repositoryName,
    creationDate: t0.toISOString(),
    lastModifiedDate: lastActivity.toISOString(),
    status: "OPEN",
    sourceBranch: "feature",
    destinationBranch: "main",
    isMergeable: 1,
    isApproved: tag === "older" ? 0 : 1,
    approvalUnknownReason: null,
    commentCount: tag === "older" ? 1 : 2,
    link: "https://example.invalid/pr/60",
    approvedBy: [],
    approvedByArns: [],
    approvalRules: [rule(tag !== "older")]
  })

type Writer = (repo: PullRequestRepoContract, version: RowVersion, tag: Tag) => Effect.Effect<unknown, unknown>
type Group = "row" | "approval"

/** A provider re-read of the pull request, whole, at `lastActivity`. */
const reread = (lastActivity: Date, tag: Tag, read: {
  readonly status?: "OPEN" | "CLOSED"
  readonly unknown?: "Throttled" | "NotPermitted"
}) => ({
  title: `Re-read ${tag}`,
  author: "author",
  status: read.status ?? "OPEN",
  creationDate: t0,
  lastActivityDate: lastActivity,
  sourceBranch: "feature",
  destinationBranch: "main",
  isMergeable: tag !== "older",
  approvedBy: [],
  approvedByArns: [],
  isApproved: tag !== "older",
  approvalRules: [rule(tag !== "older")],
  ...(read.unknown !== undefined && { approvalUnknown: { _tag: read.unknown } })
})

/** Each provider writer, the column groups it touches, and what it writes (differing by `tag`) at `version`. */
const writers: ReadonlyArray<readonly [string, ReadonlyArray<Group>, Writer]> = [
  [
    "upsert",
    ["row", "approval"],
    (repo, version, tag) => repo.upsert(listed(version.lastActivity, tag), version.observation)
  ],
  [
    "re-read",
    ["row", "approval"],
    (repo, version, tag) =>
      repo.writeRead(account, "60", reread(version.lastActivity, tag, {}), version.observation, coordinates)
  ],
  ["unknown re-read", ["row", "approval"], (repo, version, tag) =>
    repo.writeRead(
      account,
      "60",
      reread(version.lastActivity, tag, { unknown: tag === "older" ? "Throttled" : "NotPermitted" }),
      version.observation,
      coordinates
    )],
  [
    "closed re-read",
    ["row", "approval"],
    (repo, version, tag) =>
      repo.writeRead(
        account,
        "60",
        reread(version.lastActivity, tag, { status: "CLOSED" }),
        version.observation,
        coordinates
      )
  ],
  ["delete", ["row", "approval"], (repo, version) => repo.deleteOne(account, "60", version.observation, coordinates)]
]

/** Each recomputed writer, as a function of the versions it read. */
const derivedWriters: ReadonlyArray<
  readonly [string, (repo: PullRequestRepoContract, observed: RowVersions) => Effect.Effect<boolean, unknown>]
> = [
  [
    "diff stats",
    (repo, observed) =>
      repo.writeDerived(account, "60", observed, { filesAdded: 5, filesModified: 2, filesDeleted: 3 }, coordinates)
  ],
  ["comment count", (repo, observed) => repo.writeDerived(account, "60", observed, { commentCount: 9 }, coordinates)],
  ["health score", (repo, observed) => repo.writeDerived(account, "60", observed, { healthScore: 7 }, coordinates)]
]

/**
 * The older write's version: an older revision read earlier, the same revision read earlier, or an
 * older revision read later (a lagging provider replica). A not-found read has no revision, so its
 * observation alone orders it: the third family leaves deletion out on both sides (a later not-found
 * read deletes whatever the row holds, and a later read that still sees the pull request brings it
 * back; both are tested on their own).
 */
const families: ReadonlyArray<readonly [string, RowVersion, RowVersion, boolean]> = [
  [
    "an older revision read earlier",
    { lastActivity: newer, observation: 3 },
    { lastActivity: older, observation: 2 },
    true
  ],
  [
    "the same revision read earlier",
    { lastActivity: newer, observation: 3 },
    { lastActivity: newer, observation: 2 },
    true
  ],
  [
    "an older revision read later",
    { lastActivity: newer, observation: 3 },
    { lastActivity: older, observation: 4 },
    false
  ]
]

type Pair = readonly [string, Writer, RowVersion, Writer, RowVersion, ReadonlyArray<Group>]

const pairs: ReadonlyArray<Pair> = families.flatMap(([family, newerVersion, olderVersion, includeDelete]) => {
  const eligible = writers.filter(([name]) => includeDelete || name !== "delete")
  return eligible.flatMap(([newerName, touched, newerWrite]) =>
    eligible.map(([olderName, , olderWrite]): Pair => [
      `${newerName}, then ${olderName} from ${family}`,
      newerWrite,
      newerVersion,
      olderWrite,
      olderVersion,
      touched
    ])
  )
})

type Derive = (repo: PullRequestRepoContract, observed: RowVersions) => Effect.Effect<boolean, unknown>

/** Every recomputed writer, with every provider write landing between its read and its write. */
const interleavings: ReadonlyArray<readonly [string, Derive, Writer]> = derivedWriters.flatMap((
  [derivedName, derive]
) =>
  writers.filter(([name]) => name !== "delete").map(([writerName, , write]): readonly [string, Derive, Writer] => [
    `${derivedName} computed before a ${writerName} lands`,
    derive,
    write
  ])
)

const withCache = <A, E>(body: Effect.Effect<A, E, PullRequestRepo | SqlClient.SqlClient>) =>
  Effect.gen(function*() {
    const node = yield* Layer.build(NodeServices.layer)
    return yield* Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-row-writes-" })
      const services = Layer.mergeAll(PullRequestRepo.Default, DatabaseLive).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: root } })))
      )
      const context = yield* Layer.build(services)
      return yield* body.pipe(Effect.provideContext(context))
    }).pipe(Effect.provideContext(node))
  }).pipe(Effect.scoped)

/** The row as stored, minus `fetched_at`, the time of the write itself. */
const snapshot = Effect.flatMap(
  PullRequestRepo,
  (repo) => repo.findByCoordinates(account, "60", coordinates.repositoryName, coordinates.accountRegion)
).pipe(Effect.map(Option.map((row) => {
  const { fetchedAt: _, ...rest } = Schema.encodeSync(CachedPullRequest)(row)
  return rest
})))

const approvalColumns: ReadonlySet<string> = new Set(["isApproved", "approvalUnknownReason", "approvalRules"])

/** The stored row's columns in `group`, or nothing when the row is gone. */
const groupOf = <Row extends object>(row: Option.Option<Row>, group: Group) =>
  Option.map(row, (columns) =>
    Object.fromEntries(
      Object.entries(columns).filter(([column]) => approvalColumns.has(column) === (group === "approval"))
    ))

const seed = (repo: PullRequestRepoContract) => repo.upsert(listed(t0, "seed"), 1)

/** Two completion orders, labelled: the first lands first when `true`. */
const orders = (
  first: string,
  second: string
): ReadonlyArray<readonly [string, boolean]> => [[first, true], [second, false]]

/** The row's versions as a read of it now sees them. */
const observedNow = Effect.flatMap(
  PullRequestRepo,
  (repo) => repo.findByCoordinates(account, "60", coordinates.repositoryName, coordinates.accountRegion)
).pipe(Effect.map((row) => versionsOf(Option.getOrThrow(row))))

describe("pull-request row writes", () => {
  // Rule 1: provider reads write whole groups, each under its own version.
  it.effect.each(pairs)(
    "%s: the older write leaves the newer write's groups alone",
    ([, newerWrite, newerVersion, olderWrite, olderVersion, touched]) =>
      withCache(Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        yield* seed(repo)
        yield* newerWrite(repo, newerVersion, "newer")
        const afterNewer = yield* snapshot
        yield* olderWrite(repo, olderVersion, "older")
        const afterOlder = yield* snapshot
        // A deleted row stays deleted; otherwise each group the newer write touched is as it left it.
        expect(Option.isSome(afterOlder)).toBe(Option.isSome(afterNewer))
        for (const group of touched) expect(groupOf(afterOlder, group)).toEqual(groupOf(afterNewer, group))
      }))
  )

  it.effect.each(writers)("%s still applies at a newer version", ([, , write]) =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      const before = yield* snapshot
      // The "older" values differ from the seed for every writer; the version is the newest.
      yield* write(repo, { lastActivity: newest, observation: 5 }, "older")
      expect(yield* snapshot).not.toEqual(before)
    })))

  // Rule 2: a recomputed write applies only to the row as it was read, and moves no version.
  it.effect.each(interleavings)(
    "%s: the recomputed write is dropped",
    ([, derive, write]) =>
      withCache(Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        yield* seed(repo)
        const observed = yield* observedNow
        yield* write(repo, { lastActivity: newer, observation: 3 }, "newer")
        const afterProvider = yield* snapshot
        expect(yield* derive(repo, observed)).toBe(false)
        expect(yield* snapshot).toEqual(afterProvider)
      }))
  )

  it.effect.each(derivedWriters)(
    "%s applies to an unchanged row and moves no version",
    ([, derive]) =>
      withCache(Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        yield* seed(repo)
        const observed = yield* observedNow
        expect(yield* derive(repo, observed)).toBe(true)
        expect(yield* observedNow).toEqual(observed)
      }))
  )

  // Partial vs full, the round-13 case: a status re-read and a full listing of the same new revision.
  // Both are whole now, so whichever began later wins and the row has the final details either way.
  it.effect.each(orders("the status re-read lands first", "the listing lands first"))(
    "keeps the final details and status of a closed pull request (%s)",
    ([, statusFirst]) =>
      withCache(Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        yield* seed(repo)
        const listing = yield* repo.observe()
        const statusRead = yield* repo.observe()
        const final = Schema.decodeSync(UpsertInput)({
          ...Schema.encodeSync(UpsertInput)(listed(older, "newer")),
          title: "Final title",
          description: "Final description"
        })
        const writeListing = repo.upsert(final, listing)
        const writeStatus = repo.writeRead(
          account,
          "60",
          {
            ...reread(older, "newer", { status: "CLOSED" }),
            title: "Final title",
            description: "Final description"
          },
          statusRead,
          coordinates
        )
        yield* statusFirst
          ? writeStatus.pipe(Effect.andThen(writeListing))
          : writeListing.pipe(Effect.andThen(writeStatus))
        const row = Option.getOrThrow(yield* snapshot)
        expect([row.title, row.description, row.status]).toEqual(["Final title", "Final description", "CLOSED"])
      }))
  )

  // Cross-group: the health score depends on the approval, so an approval change drops it.
  it.effect("drops a health score computed before the approval changed", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      const observed = yield* observedNow
      yield* repo.writeRead(
        account,
        "60",
        reread(t0, "newer", { unknown: "NotPermitted" }),
        2, /* after the seed's observation */
        coordinates
      )
      expect(yield* repo.writeDerived(account, "60", observed, { healthScore: 9.5 }, coordinates)).toBe(false)
    })))

  it.effect("reports which groups an upsert wrote, and the versions the row holds", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      const written = yield* repo.upsert(listed(older, "older"), yield* repo.observe())
      expect([written.row, written.approval]).toEqual([true, true])
      expect(written.versions).toEqual(yield* observedNow)
      const rejected = yield* repo.upsert(listed(t0, "older"), 0)
      expect([rejected.row, rejected.approval, rejected.versions]).toEqual([false, false, undefined])
    })))

  // The case the provider date alone missed: approval turned unknown without the revision moving.
  it.effect("keeps a newer unknown approval when an earlier read of the same revision lands later", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      const slow = yield* repo.observe()
      const fast = yield* repo.observe()
      yield* repo.writeRead(account, "60", reread(t0, "newer", { unknown: "NotPermitted" }), fast, coordinates)
      expect((yield* repo.upsert(listed(t0, "older"), slow)).approval).toBe(false)
      expect(Option.map(yield* snapshot, (row) => row.approvalUnknownReason)).toEqual(Option.some("NotPermitted"))
      // A read that began after both still recovers it.
      expect((yield* repo.upsert(listed(t0, "newest"), yield* repo.observe())).approval).toBe(true)
      expect(Option.map(yield* snapshot, (row) => row.approvalUnknownReason)).toEqual(Option.some(null))
    })))

  // Without the sequence row every read would get the same number and stop being ordered, so
  // observe fails, typed, rather than hand out a fallback number.
  it.effect("fails, typed, when the observation sequence row is missing", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM observation_sequence`
      const failure = yield* Effect.flip(repo.observe())
      expect(failure._tag).toBe("CacheError")
      expect(Predicate.isTagged(failure.cause, "ObservationSequenceMissing")).toBe(true)
    })))

  it.effect("hands out strictly increasing observation numbers", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const numbers = yield* Effect.all([repo.observe(), repo.observe(), repo.observe()], { concurrency: 3 })
      expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3])
    })))

  // Rule 3 and the tombstone: only a read begun after the deletion, of a revision no older, brings it back.
  it.effect("re-inserts a deleted pull request only from a read begun after the deletion", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      const before = yield* repo.observe()
      yield* repo.deleteOne(account, "60", yield* repo.observe(), coordinates)
      yield* repo.upsert(listed(older, "older"), before)
      expect(Option.isNone(yield* snapshot)).toBe(true)
      yield* repo.upsert(listed(newest, "newest"), yield* repo.observe())
      expect(Option.map(yield* snapshot, (row) => row.title)).toEqual(Option.some("PR newest"))
    })))

  // Tombstones expire by when the deletion happened (the cache clock), not by the pull request's
  // provider activity, which can be years old.
  it.effect("keeps a tombstone of an old pull request through an expiry cutoff that precedes its deletion", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      const before = yield* repo.observe()
      yield* repo.deleteOne(account, "60", yield* repo.observe(), coordinates)
      yield* repo.deleteStale("2026-10-05T00:00:00.000Z")
      yield* repo.upsert(listed(older, "older"), before)
      expect(Option.isNone(yield* snapshot)).toBe(true)
      yield* repo.deleteStale("2999-01-01T00:00:00.000Z")
      yield* repo.upsert(listed(older, "older"), before)
      expect(Option.isSome(yield* snapshot)).toBe(true)
    })))

  // A not-found read carries no revision: its order is its observation. A listing that began before it
  // but read a newer revision must not bring the row back, in either completion order.
  it.effect.each(orders("the listing lands first", "the deletion lands first"))(
    "keeps a pull request deleted by a later not-found read when an earlier listing saw a newer revision (%s)",
    ([, listingFirst]) =>
      withCache(Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        yield* seed(repo)
        const listing = yield* repo.observe()
        const notFound = yield* repo.observe()
        const land = repo.upsert(listed(older, "older"), listing)
        const remove = repo.deleteOne(account, "60", notFound, coordinates)
        yield* listingFirst ? land.pipe(Effect.andThen(remove)) : remove.pipe(Effect.andThen(land))
        expect(Option.isNone(yield* snapshot)).toBe(true)
        yield* repo.upsert(listed(newest, "newest"), yield* repo.observe())
        expect(Option.isSome(yield* snapshot)).toBe(true)
      }))
  )

  it.effect("deletes a row from a not-found read that began after its last write, whatever revision it held", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      yield* repo.upsert(listed(newest, "newest"), yield* repo.observe())
      expect(yield* repo.deleteOne(account, "60", yield* repo.observe(), coordinates)).toBe(true)
      expect(Option.isNone(yield* snapshot)).toBe(true)
    })))

  // Rule 3: a later not-found read advances the tombstone even when the row is already gone, so a
  // listing that began between the two deletions can't bring the pull request back.
  it.effect("advances a tombstone from a repeated not-found read, and never lowers it", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      yield* repo.deleteOne(account, "60", yield* repo.observe(), coordinates)
      const between = yield* repo.observe()
      const later = yield* repo.observe()
      yield* repo.deleteOne(account, "60", later, coordinates)
      // An older repeated not-found read must not lower it again.
      yield* repo.deleteOne(account, "60", between - 1, coordinates)
      yield* repo.upsert(listed(t0, "older"), between)
      expect(Option.isNone(yield* snapshot)).toBe(true)
      yield* repo.upsert(listed(t0, "newest"), yield* repo.observe())
      expect(Option.isSome(yield* snapshot)).toBe(true)
    })))

  // Rule 1: a group's values come from the read. A refresh of a merged pull request writes the merger
  // and closing time it read; it never clears what it didn't read.
  it.effect("keeps a merged pull request's merger and closing time through a re-read of it", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      const merged = {
        ...reread(older, "newer", { status: "CLOSED" }),
        status: "MERGED",
        mergedBy: "merger"
      }
      yield* repo.writeRead(account, "60", merged, yield* repo.observe(), coordinates)
      yield* repo.upsertRead(listed(older, "newer"), merged, yield* repo.observe())
      const row = Option.getOrThrow(yield* snapshot)
      expect([row.status, row.mergedBy, row.closedAt]).toEqual(["MERGED", "merger", older.toISOString()])
    })))

  // A notification diffs against the row a write replaced, read in the same transaction.
  it.effect("reports the row an upsert replaced, and none for a pull request seen for the first time", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const first = yield* repo.upsert(listed(t0, "seed"), yield* repo.observe())
      expect(Option.isNone(first.replaced)).toBe(true)
      const second = yield* repo.upsert(listed(older, "older"), yield* repo.observe())
      expect(Option.map(second.replaced, (row) => [row.title, row.isApproved])).toEqual(Option.some(["PR seed", true]))
    })))

  // Approvers are who approved now, not who ever approved: a read with none clears them, and only a
  // read that couldn't fetch them keeps the last known list.
  describe("approvers", () => {
    const approvers = Effect.flatMap(
      PullRequestRepo,
      (repo) => repo.findByCoordinates(account, "60", coordinates.repositoryName, coordinates.accountRegion)
    ).pipe(Effect.map(Option.map((row) => [row.approvedBy, row.approvedByArns])))
    const withApprovers = (lastActivity: Date, names: ReadonlyArray<string>, unknown = false) => ({
      ...listed(lastActivity, "seed"),
      approvedBy: [...names],
      approvedByArns: names.map((name) => `arn:aws:iam::123456789012:user/${name}`),
      ...(unknown && { approversUnknown: true })
    })

    it.effect("clears an approval revoked down to no approvers", () =>
      withCache(Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        yield* repo.upsert(withApprovers(t0, ["alice"]), yield* repo.observe())
        yield* repo.upsert(withApprovers(older, []), yield* repo.observe())
        expect(yield* approvers).toEqual(Option.some([[], []]))
      })))

    it.effect("keeps the last known approvers when a read couldn't fetch them", () =>
      withCache(Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        yield* repo.upsert(withApprovers(t0, ["alice"]), yield* repo.observe())
        yield* repo.upsert(withApprovers(older, [], true), yield* repo.observe())
        expect(yield* approvers).toEqual(Option.some([["alice"], ["arn:aws:iam::123456789012:user/alice"]]))
      })))

    // Approvers move with approval's version: a read whose approval is older than the stored one writes
    // its row group but not its approvers.
    it.effect("writes approvers only when the read's approval group applies", () =>
      withCache(Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        const sql = yield* SqlClient.SqlClient
        yield* repo.upsert(withApprovers(t0, ["alice"]), yield* repo.observe())
        yield* sql`UPDATE pull_requests SET approval_version = ${newer.toISOString()}`
        yield* repo.upsert({ ...withApprovers(older, ["bob"]), title: "Row moved" }, yield* repo.observe())
        const row = yield* repo.findByCoordinates(account, "60", coordinates.repositoryName, coordinates.accountRegion)
        expect(Option.map(row, (r) => [r.title, r.approvedBy])).toEqual(Option.some(["Row moved", ["alice"]]))
      })))
  })
})
