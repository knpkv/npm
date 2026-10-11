import { describe, expect, it } from "@effect/vitest"
import type { HostCacheReads } from "@knpkv/codecommit-core/CacheService/HostReads.js"
import { CachedPullRequest } from "@knpkv/codecommit-core/CacheService/repos/PullRequestRepo/internal.js"
import type { NewAuditLogEntry } from "@knpkv/codecommit-core/PermissionService/AuditLog.js"
import * as ReadClient from "@knpkv/codecommit-core/ReadClient.js"
import { Effect, Ref, Result, Schema, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import { type CodeQueueQuery, CodeReference } from "../src/host-contract.js"
import { CodeHostReadError, type CodeReferenceStore } from "../src/server/host-model.js"
import { makeCodeHostReadsFromClient } from "../src/server/host-read.js"

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

const fixture = Effect.fn("CodeHostTest.fixture")(function*() {
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
    references,
    configPath: "/fixture/config.json",
    permissionPath: "/fixture/permissions.json"
  }, inner).pipe(Effect.provideService(FileSystem.FileSystem, fs))
  return { reads, config, policy, providerCalls, audit, profileQueries }
})

describe("Code host read service", () => {
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
