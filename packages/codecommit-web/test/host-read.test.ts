import { describe, expect, it } from "@effect/vitest"
import { type HostCacheReads, HostCommentsReadError } from "@knpkv/codecommit-core/CacheService/HostReads.js"
import { CachedPullRequest } from "@knpkv/codecommit-core/CacheService/repos/PullRequestRepo/internal.js"
import { Account, AwsProfileName, PullRequest } from "@knpkv/codecommit-core/Domain.js"
import type { NewAuditLogEntry } from "@knpkv/codecommit-core/PermissionService/AuditLog.js"
import * as ReadClient from "@knpkv/codecommit-core/ReadClient.js"
import { Effect, Ref, Result, Schema, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import { type CodeQueueQuery, CodeReference } from "../src/host-contract.js"
import { cachedPullRequest } from "../src/server/handlers/prs-live.js"
import { CodeHostReadError, type CodeReferenceStore } from "../src/server/host-model.js"
import { makeCodeHostReadsFromClient } from "../src/server/host-read.js"
import { reviewRunSubject } from "../src/server/review/review-run-projection.js"
import { type ReviewRunReader, ReviewRunStoreError } from "../src/server/review/ReviewRunReader.js"

const account = "1".repeat(12)
const row = Schema.decodeUnknownSync(CachedPullRequest)({
  id: "42",
  awsAccountId: account,
  repoAccountId: account,
  accountProfile: "private-profile",
  accountRegion: "eu-west-1",
  title: "Read safely",
  description: "Review text",
  author: `arn:aws:sts::${account}:assumed-role/Reviewers/example-author`,
  repositoryName: "example",
  creationDate: "2026-10-10T00:00:00Z",
  lastModifiedDate: "2026-10-11T00:00:00Z",
  observationSeq: 0,
  approvalVersion: "2026-10-11T00:00:00Z",
  approvalObservationSeq: 0,
  status: "OPEN",
  sourceBranch: "feature",
  destinationBranch: "main",
  isMergeable: 1,
  isApproved: 0,
  approvalUnknownReason: null,
  approvalBaselineKnown: 1,
  approversUnknown: 0,
  commentCount: null,
  healthScore: null,
  link: "https://example.invalid/private",
  fetchedAt: "2026-10-11T00:00:00Z",
  filesAdded: null,
  filesModified: null,
  filesDeleted: null,
  closedAt: null,
  mergedBy: null,
  approvedBy: null,
  approvedByArns: null,
  commentedBy: null,
  approvalRules: null
})
const ref = Schema.decodeUnknownSync(CodeReference)("00000000-0000-4000-8000-000000000001")
const query = { filter: "open", search: "", offset: 0 } satisfies CodeQueueQuery
const unused = () => Effect.die("Unexpected host provider operation")

const fixture = Effect.fn("CodeHostTest.fixture")(function*(options: {
  readonly comments?: HostCacheReads["comments"]
  readonly reviews?: ReviewRunReader
} = {}) {
  const config = yield* Ref.make<string | null>(null)
  const policy = yield* Ref.make("always_allow")
  const providerCalls = yield* Ref.make(0)
  const audit = yield* Ref.make<ReadonlyArray<NewAuditLogEntry>>([])
  const profileQueries = yield* Ref.make<ReadonlyArray<ReadonlyArray<string> | null>>([])
  const fs = FileSystem.makeNoop({
    exists: (path) =>
      path === "/fixture/permissions.json"
        ? Effect.succeed(true)
        : Ref.get(config).pipe(Effect.map((value) => value !== null)),
    readFileString: (path) =>
      path === "/fixture/permissions.json"
        ? Ref.get(policy).pipe(
          Effect.map((grant) => JSON.stringify({ permissions: { getPullRequest: grant, getDifferences: grant } }))
        )
        : Ref.get(config).pipe(Effect.map((value) => value ?? "{}"))
  })
  const cache: HostCacheReads = {
    queue: ({ profiles }) =>
      Ref.update(profileQueries, (values) => [...values, profiles]).pipe(
        Effect.as(profiles === null || profiles.includes(row.accountProfile) ? [row] : [])
      ),
    exact: () => Effect.succeed(row),
    comments: options.comments ?? (() => Effect.succeed(null)),
    log: (entry) => Ref.update(audit, (entries) => [...entries, entry])
  }
  const references: CodeReferenceStore = {
    reference: () => Effect.succeed(ref),
    resolve: (value) =>
      Effect.succeed(
        value === ref ?
          {
            accountId: row.awsAccountId,
            region: row.accountRegion,
            repository: row.repositoryName,
            id: row.id
          } :
          null
      )
  }
  const inner: ReadClient.CodeCommitReadClientService = {
    discoverAccount: unused,
    getBlob: unused,
    getRepositoryIdentity: unused,
    listPullRequestIdsPage: unused,
    listPullRequestsPage: unused,
    listRepositoriesPage: unused,
    streamChangedFiles: () => Stream.die("Unexpected raw stream"),
    streamPullRequests: () => Stream.die("Unexpected raw stream"),
    getPullRequest: () =>
      Ref.update(providerCalls, (n) => n + 1).pipe(Effect.as(
        new ReadClient.CodeCommitPullRequestRevision({
          pullRequestId: row.id,
          repositoryName: row.repositoryName,
          revisionId: "revision-1",
          title: row.title,
          authorArn: null,
          status: "OPEN",
          sourceReference: "refs/heads/feature",
          destinationReference: "refs/heads/main",
          sourceCommit: ReadClient.CodeCommitCommitId.make("a".repeat(40)),
          destinationCommit: ReadClient.CodeCommitCommitId.make("b".repeat(40)),
          mergeBase: null,
          creationDate: row.creationDate,
          lastActivityDate: row.lastModifiedDate
        })
      )),
    getChangedFilesPage: () =>
      Ref.update(providerCalls, (n) => n + 1).pipe(Effect.as(
        new ReadClient.CodeCommitChangedFilesPage({ files: [], nextToken: null, providerPageLimit: 100 })
      ))
  }
  const reads = yield* makeCodeHostReadsFromClient({
    cache,
    reviews: options.reviews ?? { read: () => Effect.succeed(null) },
    references,
    configPath: "/fixture/config.json",
    permissionPath: "/fixture/permissions.json"
  }, inner).pipe(Effect.provideService(FileSystem.FileSystem, fs))
  return { reads, config, policy, providerCalls, audit, profileQueries }
})

describe("Code host read service", () => {
  it.effect("the real owner cache selection and host reading share exact coordinates across profile renames", () =>
    Effect.gen(function*() {
      const owner = yield* cachedPullRequest({ findAll: () => Effect.succeed([row]) }, row.awsAccountId, row.id, {
        repositoryName: row.repositoryName,
        region: row.accountRegion
      })
      const ownerSubject = yield* reviewRunSubject(owner)
      const renamedSubject = yield* reviewRunSubject(
        new PullRequest({
          ...owner,
          account: new Account({ ...owner.account, profile: AwsProfileName.make("renamed-profile") })
        })
      )
      expect(renamedSubject).toBe(ownerSubject)
      const seen = yield* Ref.make<string | null>(null)
      const test = yield* fixture({
        reviews: { read: (identity) => Ref.set(seen, identity.subjectId).pipe(Effect.as(null)) }
      })
      yield* test.reads.review(ref, { login: "Reviewer" })
      expect(yield* Ref.get(seen)).toBe(ownerSubject)
      const { awsAccountId: _accountId, ...withoutIdentity } = owner.account
      expect(
        (yield* Effect.result(reviewRunSubject(
          new PullRequest({
            ...owner,
            account: new Account(withoutIdentity)
          })
        )))._tag
      ).toBe("Failure")
    }))

  it.effect("unreadable history does not discard the current diff or cached conversations", () =>
    Effect.gen(function*() {
      const test = yield* fixture({
        reviews: { read: () => Effect.fail(new ReviewRunStoreError({ operation: "read", reason: "invalid" })) },
        comments: () => Effect.succeed({ observedAt: 500, locations: [] })
      })
      const reading = yield* test.reads.review(ref, { login: "Reviewer" })
      expect(reading.workspace.run).toEqual({ _tag: "Unavailable", reason: "invalid" })
      expect(reading.diff.headCommit).toBe("a".repeat(40))
      expect(reading.workspace.conversations).toEqual({ _tag: "Ready", observedAt: 500, threads: [] })
    }))

  it.effect("retains an older completed run while rebinding its private subject to the opaque reference", () =>
    Effect.gen(function*() {
      const identities = yield* Ref.make<ReadonlyArray<string>>([])
      const test = yield* fixture({
        reviews: {
          read: (identity) =>
            Ref.update(identities, (values) => [...values, identity.subjectId]).pipe(Effect.as({
              id: "run-previous",
              identity: { ...identity, revisionId: "revision-previous", headRevision: "c".repeat(40) },
              profile: null,
              kind: "review",
              completedAt: 1_000,
              summary: "Previous completed review",
              explanation: null,
              risks: null,
              focus: null,
              rules: null,
              threads: []
            }))
        },
        comments: () => Effect.succeed({ observedAt: 500, locations: [] })
      })
      const reading = yield* test.reads.review(ref, { login: "Reviewer" })
      expect(reading.workspace.identity.headRevision).toBe("a".repeat(40))
      expect(reading.workspace.run._tag).toBe("Ready")
      if (reading.workspace.run._tag === "Ready") {
        expect(reading.workspace.run.run.identity).toMatchObject({ subjectId: ref, headRevision: "c".repeat(40) })
      }
      expect(reading.workspace.conversations).toEqual({ _tag: "Ready", observedAt: 500, threads: [] })
      expect(yield* Ref.get(identities)).toEqual([
        JSON.stringify([row.awsAccountId, row.accountRegion, row.repositoryName, row.id])
      ])
      for (const value of [row.awsAccountId, row.accountProfile, row.accountRegion]) {
        expect(JSON.stringify(reading.workspace)).not.toContain(value)
      }
    }))

  it.effect("preserves oversized versus corrupt cached comments without converting either to an empty conversation", () =>
    Effect.gen(function*() {
      for (const reason of ["over_limit", "corrupt"] satisfies ReadonlyArray<HostCommentsReadError["reason"]>) {
        const test = yield* fixture({ comments: () => Effect.fail(new HostCommentsReadError({ reason })) })
        const reading = yield* test.reads.review(ref, { login: "Reviewer" })
        expect(reading.workspace.conversations).toEqual({ _tag: "Unavailable", reason })
        expect(yield* Ref.get(test.providerCalls)).toBe(2)
      }
    }))

  it.effect("review reads obey fresh saved grants before provider calls", () =>
    Effect.gen(function*() {
      const test = yield* fixture()
      yield* Ref.set(test.policy, "allow")
      const refused = yield* Effect.result(test.reads.review(ref, { login: "Reviewer" }))
      expect(refused._tag).toBe("Failure")
      if (refused._tag === "Failure") expect(refused.failure.reason).toBe("permission_required")
      expect(yield* Ref.get(test.providerCalls)).toBe(0)
    }))

  it.effect("reads reviews without review execution or comment-provider authority", () =>
    Effect.gen(function*() {
      const test = yield* fixture()
      const reading = yield* test.reads.review(ref, { login: "Reviewer" })
      expect(reading.workspace.run).toEqual({ _tag: "NotRecorded" })
      expect(reading.workspace.identity.subjectId).toBe(ref)
      expect(reading.workspace.conversations).toEqual({ _tag: "Unavailable", reason: "not_cached" })
      expect(reading.workspace.checks).toEqual({ _tag: "Unknown" })
      expect(yield* Ref.get(test.providerCalls)).toBe(2)
      // Each read records admission and duration; comments require no additional provider operation.
      expect((yield* Ref.get(test.audit)).map((entry) => entry.operation)).toEqual([
        "getPullRequest",
        "getPullRequest",
        "getDifferences",
        "getDifferences"
      ])
      for (const privateValue of [row.accountProfile, row.accountRegion, row.awsAccountId]) {
        expect(JSON.stringify(reading.workspace)).not.toContain(privateValue)
      }
      expect(Object.keys(test.reads).sort()).toEqual(["detail", "diff", "diffContent", "queue", "review"])
    }))

  /** An unreadable enabled set must never reuse the previous visible accounts. */
  it.effect("refuses malformed queue configuration instead of using stale visibility", () =>
    Effect.gen(function*() {
      const test = yield* fixture()
      yield* test.reads.queue(query)
      yield* Ref.set(test.config, "not-json")
      const result = yield* Effect.result(test.reads.queue(query))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure.reason).toBe("config_unavailable")
      expect(yield* Ref.get(test.profileQueries)).toEqual([null])
      expect(yield* Ref.get(test.providerCalls)).toBe(0)
    }))

  it.effect("rereads queue visibility, while exact targets remain addressable", () =>
    Effect.gen(function*() {
      const test = yield* fixture()
      expect((yield* test.reads.queue(query))._tag).toBe("Ready")
      yield* Ref.set(test.config, "{\"accounts\":[]}")
      const hidden = yield* test.reads.queue(query)
      if (hidden._tag === "Ready") expect(hidden.items).toEqual([])
      expect((yield* test.reads.detail(ref))._tag).toBe("Ready")
      yield* Ref.set(test.config, "{\"accounts\":[{\"profile\":\"private-profile\",\"enabled\":true}]}")
      const enabled = yield* test.reads.queue(query)
      if (enabled._tag === "Ready") expect(enabled.items).toHaveLength(1)
      expect(yield* Ref.get(test.profileQueries)).toEqual([null, [], ["private-profile"]])
    }))

  it.effect("redacts provider locators and derives author display server-side", () =>
    Effect.gen(function*() {
      const test = yield* fixture()
      const result = yield* test.reads.detail(ref)
      const wire = JSON.stringify(result)
      for (const privateValue of [account, row.accountProfile, row.accountRegion, row.author, row.link]) {
        expect(wire).not.toContain(privateValue)
      }
      if (result._tag === "Ready") expect(result.item.author).toBe("example-author")
      expect(yield* Ref.get(test.providerCalls)).toBe(0)
    }))

  it.effect("reuses one provider for separately attributed callers and refuses revocation", () =>
    Effect.gen(function*() {
      const test = yield* fixture()
      yield* test.reads.diff(ref, { login: "viewer-one" })
      yield* test.reads.diff(ref, { login: "viewer-two" })
      expect(yield* Ref.get(test.providerCalls)).toBe(4)
      const entries = yield* Ref.get(test.audit)
      expect(entries.slice(0, 4).every((entry) => entry.context.startsWith("hub:viewer-one "))).toBe(true)
      expect(entries.slice(4).every((entry) => entry.context.startsWith("hub:viewer-two "))).toBe(true)
      yield* Ref.set(test.policy, "allow")
      const refused = yield* Effect.result(test.reads.diff(ref, { login: "viewer-two" }))
      if (Result.isFailure(refused)) expect(refused.failure.reason).toBe("permission_required")
      else expect.fail("Would-ask read executed")
      expect(yield* Ref.get(test.providerCalls)).toBe(4)
    }))

  it.effect("returns typed not_found for an unmapped reference", () =>
    Effect.gen(function*() {
      const test = yield* fixture()
      const outcome = yield* Effect.result(
        test.reads.detail(Schema.decodeUnknownSync(CodeReference)("00000000-0000-4000-8000-000000000002"))
      )
      expect(Result.isFailure(outcome)).toBe(true)
      if (Result.isFailure(outcome)) expect(outcome.failure).toEqual(new CodeHostReadError({ reason: "not_found" }))
      expect(yield* Ref.get(test.providerCalls)).toBe(0)
    }))
})
