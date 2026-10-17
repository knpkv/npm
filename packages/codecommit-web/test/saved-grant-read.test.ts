import { describe, expect, it } from "@effect/vitest"
import { Domain, ReadClient } from "@knpkv/codecommit-core"
import { CacheError } from "@knpkv/codecommit-core/CacheService/CacheError.js"
import { ConfigError } from "@knpkv/codecommit-core/Errors.js"
import { AuditLogRepo, type NewAuditLogEntry } from "@knpkv/codecommit-core/PermissionService/AuditLog.js"
import { PermissionService, type PermissionState } from "@knpkv/codecommit-core/PermissionService/index.js"
import { PermissionGate } from "@knpkv/codecommit-core/PermissionService/PermissionGate.js"
import { Effect, Logger, Predicate, Ref, Result, Stream } from "effect"
import { makePermissionedReadClient } from "../src/server/internal/PermissionedReadClient.js"

const unused = <A>(): Effect.Effect<A> => Effect.die("unexpected operation in saved-grant fixture")

const blobRequest = {
  account: { profile: Domain.AwsProfileName.make("read-source"), region: Domain.AwsRegion.make("eu-west-1") },
  repositoryName: Domain.RepositoryName.make("example"),
  blobId: ReadClient.CodeCommitBlobId.make("a".repeat(40))
}

const fixture = Effect.fn("SavedGrantReadTest.fixture")(
  function*(
    state: PermissionState,
    savedGrantsOnly: boolean,
    failAudit: boolean = false,
    caller = "example-viewer",
    policyFailure?: ConfigError
  ) {
    const providerCalls = yield* Ref.make(0)
    const prompts = yield* Ref.make(0)
    const permissionWrites = yield* Ref.make(0)
    const permissionState = yield* Ref.make(state)
    const audit = yield* Ref.make<ReadonlyArray<NewAuditLogEntry>>([])
    const inner: ReadClient.CodeCommitReadClientService = {
      discoverAccount: () => unused(),
      getCommit: () => Effect.die("unused getCommit"),
      getBlob: ({ blobId }) =>
        Ref.update(providerCalls, (n) => n + 1).pipe(
          Effect.as(
            new ReadClient.CodeCommitBlobContent({
              blobId: ReadClient.CodeCommitBlobId.make(blobId),
              bytes: new Uint8Array()
            })
          )
        ),
      getChangedFilesPage: () => unused(),
      getPullRequest: () => unused(),
      getRepositoryIdentity: () => unused(),
      listPullRequestIdsPage: () => unused(),
      listPullRequestsPage: () => unused(),
      listRepositoriesPage: () => unused(),
      streamChangedFiles: () => Stream.die("unexpected stream in saved-grant fixture"),
      streamPullRequests: () => Stream.die("unexpected stream in saved-grant fixture")
    }
    const permissions: PermissionService["Service"] = {
      check: () => Effect.succeed(state),
      getAll: () => Effect.succeed({}),
      getAuditRetention: () => Effect.succeed(30),
      isAuditEnabled: () => Effect.succeed(true),
      resetAll: () => Ref.update(permissionWrites, (n) => n + 1),
      set: () => Ref.update(permissionWrites, (n) => n + 1),
      setAudit: () => Ref.update(permissionWrites, (n) => n + 1),
      setCategory: () => Ref.update(permissionWrites, (n) => n + 1)
    }
    const auditLog: AuditLogRepo["Service"] = {
      log: (entry) =>
        failAudit
          ? Effect.fail(new CacheError({ operation: "log", cause: "fixture audit unavailable" }))
          : Ref.update(audit, (entries) => [...entries, entry]),
      clearAll: () => unused(),
      exportAll: () => unused(),
      findAll: () => unused(),
      prune: () => unused()
    }
    const client = yield* makePermissionedReadClient(
      inner,
      savedGrantsOnly
        ? {
          mode: "saved-grants",
          caller,
          check: () => policyFailure === undefined ? Ref.get(permissionState) : Effect.fail(policyFailure)
        }
        : { mode: "owner" }
    ).pipe(
      Effect.provideService(PermissionService, permissions),
      Effect.provideService(PermissionGate, {
        request: () => Ref.update(prompts, (n) => n + 1).pipe(Effect.as("allow_once"))
      }),
      Effect.provideService(AuditLogRepo, auditLog)
    )
    return { client, providerCalls, prompts, permissionWrites, audit, permissionState }
  }
)

describe("saved-grant provider reads", () => {
  /** A tailnet read cannot register a permission prompt that only the owner UI can answer. */
  it.effect("returns PermissionRequired without a prompt, provider call or permission write", () =>
    Effect.gen(function*() {
      const test = yield* fixture("allow", true)
      const outcome = yield* Effect.result(test.client.getBlob(blobRequest))
      expect(Result.isFailure(outcome)).toBe(true)
      if (Result.isFailure(outcome)) {
        expect(Predicate.isTagged(outcome.failure, "AwsApiError")).toBe(true)
        if (Predicate.isTagged(outcome.failure, "AwsApiError")) {
          expect(Predicate.isTagged(outcome.failure.cause, "PermissionRequired")).toBe(true)
        }
      }
      expect(yield* Ref.get(test.providerCalls)).toBe(0)
      expect(yield* Ref.get(test.prompts)).toBe(0)
      expect(yield* Ref.get(test.permissionWrites)).toBe(0)
      expect((yield* Ref.get(test.audit)).map(({ permissionState }) => permissionState)).toEqual(["denied"])
    }))

  it.effect("executes and audits an existing standing grant without prompting", () =>
    Effect.gen(function*() {
      const test = yield* fixture("always_allow", true)
      yield* test.client.getBlob(blobRequest)
      expect(yield* Ref.get(test.providerCalls)).toBe(1)
      expect(yield* Ref.get(test.prompts)).toBe(0)
      expect(yield* Ref.get(test.permissionWrites)).toBe(0)
      expect((yield* Ref.get(test.audit)).map(({ permissionState }) => permissionState)).toEqual([
        "always_allowed",
        "always_allowed"
      ])
    }))

  it.effect("keeps an explicit denial closed and audited", () =>
    Effect.gen(function*() {
      const test = yield* fixture("deny", true)
      expect(Result.isFailure(yield* Effect.result(test.client.getBlob(blobRequest)))).toBe(true)
      expect(yield* Ref.get(test.providerCalls)).toBe(0)
      expect(yield* Ref.get(test.prompts)).toBe(0)
      expect(yield* Ref.get(test.permissionWrites)).toBe(0)
      expect((yield* Ref.get(test.audit)).map(({ permissionState }) => permissionState)).toEqual(["denied"])
    }))

  it.effect("retains the owner UI interactive path when saved-grant mode is disabled", () =>
    Effect.gen(function*() {
      const test = yield* fixture("allow", false)
      yield* test.client.getBlob(blobRequest)
      expect(yield* Ref.get(test.prompts)).toBe(1)
      expect(yield* Ref.get(test.providerCalls)).toBe(1)
      expect((yield* Ref.get(test.audit)).map(({ permissionState }) => permissionState)).toEqual(["allowed"])
    }))

  /** An audited remote read has no authority when the audit cannot be persisted. */
  it.effect("refuses a saved-grant read before provider execution when the audit is unavailable", () =>
    Effect.gen(function*() {
      const test = yield* fixture("always_allow", true, true)
      const outcome = yield* Effect.result(test.client.getBlob(blobRequest))
      expect(Result.isFailure(outcome)).toBe(true)
      if (Result.isFailure(outcome) && Predicate.isTagged(outcome.failure, "AwsApiError")) {
        expect(Predicate.isTagged(outcome.failure.cause, "AuditUnavailable")).toBe(true)
      }
      expect(yield* Ref.get(test.providerCalls)).toBe(0)
    }))

  it.effect("records the authenticated hub caller on standing grants and would-ask denials", () =>
    Effect.gen(function*() {
      for (const state of ["always_allow", "allow"] satisfies ReadonlyArray<PermissionState>) {
        const test = yield* fixture(state, true)
        yield* Effect.result(test.client.getBlob(blobRequest))
        const entries = yield* Ref.get(test.audit)
        expect(entries.length).toBeGreaterThan(0)
        expect(entries.every(({ context }) => context.startsWith("hub:example-viewer "))).toBe(true)
      }
    }))

  it.effect("preserves owner reads when their best-effort audit fails", () =>
    Effect.gen(function*() {
      const test = yield* fixture("always_allow", false, true)
      yield* test.client.getBlob(blobRequest)
      expect(yield* Ref.get(test.providerCalls)).toBe(1)
    }))

  it.effect("honours a revoked standing grant on the next provider read", () =>
    Effect.gen(function*() {
      const test = yield* fixture("always_allow", true)
      yield* test.client.getBlob(blobRequest)
      yield* Ref.set(test.permissionState, "allow")
      const outcome = yield* Effect.result(test.client.getBlob(blobRequest))
      expect(Result.isFailure(outcome)).toBe(true)
      if (Result.isFailure(outcome) && Predicate.isTagged(outcome.failure, "AwsApiError")) {
        expect(Predicate.isTagged(outcome.failure.cause, "PermissionRequired")).toBe(true)
      }
      expect(yield* Ref.get(test.providerCalls)).toBe(1)
      expect(yield* Ref.get(test.prompts)).toBe(0)
    }))

  it.effect("rejects an ambiguous audit caller before constructing a saved-grant client", () =>
    Effect.gen(function*() {
      for (const caller of ["a b", "a\nb", "", "a".repeat(255)]) {
        const outcome = yield* Effect.result(fixture("always_allow", true, false, caller))
        expect(Result.isFailure(outcome)).toBe(true)
        if (Result.isFailure(outcome)) expect(Predicate.isTagged(outcome.failure, "ReadCallerInvalid")).toBe(true)
      }
    }))

  it.effect("records a broken grant store with the caller and refuses provider execution", () =>
    Effect.gen(function*() {
      const cause = new ConfigError({ message: "saved policy unavailable", cause: "fixture read denied" })
      const test = yield* fixture("always_allow", true, false, "example-viewer", cause)
      const messages: Array<unknown> = []
      const logger = Logger.make<unknown, void>((entry) => messages.push(entry.message))
      const outcome = yield* Effect.result(test.client.getBlob(blobRequest)).pipe(Effect.withLogger(logger))
      expect(Result.isFailure(outcome)).toBe(true)
      if (Result.isFailure(outcome) && Predicate.isTagged(outcome.failure, "AwsApiError")) {
        expect(Predicate.isTagged(outcome.failure.cause, "PermissionRequired")).toBe(true)
      }
      expect(yield* Ref.get(test.providerCalls)).toBe(0)
      expect((yield* Ref.get(test.audit)).map(({ context }) => context)).toEqual([
        "hub:example-viewer Saved policy unavailable: Read immutable blob in example"
      ])
      expect(messages).toContainEqual([
        "Code saved permission policy could not be read",
        { caller: "example-viewer", cause }
      ])
    }))
})
