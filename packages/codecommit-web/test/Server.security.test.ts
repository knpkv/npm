import { describe, expect, it } from "@effect/vitest"
import { Domain, ReadClient } from "@knpkv/codecommit-core"
import { PermissionDeniedError } from "@knpkv/codecommit-core/Errors.js"
import { AuditLogRepo, type NewAuditLogEntry } from "@knpkv/codecommit-core/PermissionService/AuditLog.js"
import { PermissionService, type PermissionState } from "@knpkv/codecommit-core/PermissionService/index.js"
import { PermissionGate } from "@knpkv/codecommit-core/PermissionService/PermissionGate.js"
import { Duration, Effect, Redacted, Ref, Result, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpServerResponse } from "effect/unstable/http"
import { CodeCommitApi, OwnerSessionAuth, type PullRequestDiffContentResponse } from "../src/server/Api.js"
import { makeDiffContentResponse } from "../src/server/handlers/prs-live.js"
import { encodeSandbox } from "../src/server/handlers/sandbox-live.js"
import {
  activateOwnerSessionBootstrap,
  authorizeBootstrapRequest,
  authorizeOwnerRequest,
  ownerSessionCookie,
  type OwnerSessionSecretsShape,
  ownerSessionUrl,
  ownerSessionUrlForOrigin,
  requireLoopbackHostname,
  requireLoopbackOrigin
} from "../src/server/internal/OwnerSessionSecurity.js"
import { makePermissionedReadClient } from "../src/server/internal/PermissionedReadClient.js"

const makeSecrets = Effect.fn("ServerSecurityTest.makeSecrets")(
  function*(active = true): Effect.fn.Return<OwnerSessionSecretsShape> {
    return {
      ownerToken: Redacted.make("owner-secret"),
      csrfToken: Redacted.make("csrf-secret"),
      bootstrapToken: Redacted.make("bootstrap-secret"),
      bootstrapAvailable: yield* Ref.make(true),
      bootstrapExpiresAtMillis: yield* Ref.make<number | undefined>(active ? Number.MAX_SAFE_INTEGER : undefined)
    }
  }
)

const unused = <A>(): Effect.Effect<A> => Effect.die("unused read-client operation")

const makePermissionService = (
  state: PermissionState,
  updates?: Ref.Ref<ReadonlyArray<readonly [string, PermissionState]>>
): PermissionService["Service"] => ({
  check: () => Effect.succeed(state),
  getAll: () => Effect.succeed({}),
  getAuditRetention: () => Effect.succeed(30),
  isAuditEnabled: () => Effect.succeed(true),
  resetAll: () => Effect.void,
  set: (operation, nextState) => {
    const update: readonly [string, PermissionState] = [operation, nextState]
    return updates === undefined
      ? Effect.void
      : Ref.update(updates, (current) => [...current, update])
  },
  setAudit: () => Effect.void
})

const makeAuditLog = (entries: Ref.Ref<ReadonlyArray<NewAuditLogEntry>>): AuditLogRepo["Service"] => ({
  clearAll: () => unused(),
  exportAll: () => unused(),
  findAll: () => unused(),
  log: (entry) => Ref.update(entries, (current) => [...current, entry]),
  prune: () => unused()
})

const readAccount = {
  profile: Domain.AwsProfileName.make("production"),
  region: Domain.AwsRegion.make("eu-west-1")
}

const changedFile = new ReadClient.CodeCommitChangedFile({
  before: null,
  after: new ReadClient.CodeCommitBlobMetadata({
    blobId: ReadClient.CodeCommitBlobId.make("c".repeat(40)),
    mode: "100644",
    path: "src/index.ts"
  }),
  status: "added"
})

const makeObservedReadClient = (
  calls: Ref.Ref<{ readonly blob: number; readonly differences: number }>
): ReadClient.CodeCommitReadClientService => ({
  discoverAccount: () => unused(),
  getBlob: ({ blobId }) =>
    Ref.update(calls, (count) => ({ ...count, blob: count.blob + 1 })).pipe(
      Effect.as(new ReadClient.CodeCommitBlobContent({ blobId, bytes: new Uint8Array() }))
    ),
  getChangedFilesPage: () =>
    Ref.update(calls, (count) => ({ ...count, differences: count.differences + 1 })).pipe(
      Effect.as(
        new ReadClient.CodeCommitChangedFilesPage({
          files: [changedFile],
          nextToken: null,
          providerPageLimit: 100
        })
      )
    ),
  getPullRequest: () => unused(),
  getRepositoryIdentity: () => unused(),
  listPullRequestIdsPage: () => unused(),
  listPullRequestsPage: () => unused(),
  listRepositoriesPage: () => unused(),
  streamChangedFiles: () => Stream.die("permissioned client must build streams from gated pages"),
  streamPullRequests: () => Stream.empty
})

const makeTestPermissionedReadClient = Effect.fn("ServerSecurityTest.makePermissionedReadClient")(function*(
  state: PermissionState,
  calls: Ref.Ref<{ readonly blob: number; readonly differences: number }>,
  auditEntries: Ref.Ref<ReadonlyArray<NewAuditLogEntry>>,
  gateRequest: PermissionGate["Service"]["request"] = () => unused(),
  permissionUpdates?: Ref.Ref<ReadonlyArray<readonly [string, PermissionState]>>
) {
  return yield* makePermissionedReadClient(makeObservedReadClient(calls)).pipe(
    Effect.provideService(PermissionService, makePermissionService(state, permissionUpdates)),
    Effect.provideService(PermissionGate, PermissionGate.of({ request: gateRequest })),
    Effect.provideService(AuditLogRepo, makeAuditLog(auditEntries))
  )
})

describe("CodeCommit web security boundary", () => {
  it("attaches owner authentication to every API endpoint", () => {
    let checked = 0
    for (const group of Object.values(CodeCommitApi.groups)) {
      for (const endpoint of Object.values(group.endpoints)) {
        expect(endpoint.middlewares.has(OwnerSessionAuth)).toBe(true)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it.effect("prevents caching selected-file source responses without changing their body", () =>
    Effect.gen(function*() {
      const content = {
        fileIndex: 0,
        revisionId: "revision-1",
        state: "text",
        before: "private before\n",
        after: "private after\n"
      } satisfies PullRequestDiffContentResponse
      const response = yield* makeDiffContentResponse(content)

      expect(response.headers["cache-control"]).toBe("no-store")
      expect(yield* Effect.promise(() => HttpServerResponse.toWeb(response).json())).toEqual(content)
    }))

  it.effect("rejects unauthenticated reads before endpoint execution", () =>
    Effect.gen(function*() {
      const secrets = yield* makeSecrets()
      const result = yield* Effect.result(authorizeOwnerRequest({
        credential: "",
        csrfToken: undefined,
        host: "127.0.0.1:3000",
        method: "GET",
        origin: undefined
      }, secrets))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure._tag).toBe("UnauthorizedApiError")
    }))

  it.effect("rejects cross-origin reads while allowing non-browser and same-origin owner reads", () =>
    Effect.gen(function*() {
      const secrets = yield* makeSecrets()
      const base = {
        credential: "owner-secret",
        csrfToken: undefined,
        host: "127.0.0.1:3000",
        method: "GET"
      }
      const crossOrigin = yield* Effect.result(
        authorizeOwnerRequest({ ...base, origin: "http://127.0.0.1:4000" }, secrets)
      )
      expect(Result.isFailure(crossOrigin)).toBe(true)
      yield* authorizeOwnerRequest({ ...base, origin: undefined }, secrets)
      yield* authorizeOwnerRequest({ ...base, origin: "http://127.0.0.1:3000" }, secrets)
    }))

  it.effect("rejects cross-site and missing-origin mutations but preserves an owner mutation", () =>
    Effect.gen(function*() {
      const secrets = yield* makeSecrets()
      const base = {
        credential: "owner-secret",
        csrfToken: "csrf-secret",
        host: "127.0.0.1:3000",
        method: "POST"
      }
      for (const origin of ["https://evil.example", undefined]) {
        const result = yield* Effect.result(authorizeOwnerRequest({ ...base, origin }, secrets))
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure._tag).toBe("ForbiddenApiError")
      }
      const invalidCsrf = yield* Effect.result(authorizeOwnerRequest({
        ...base,
        csrfToken: "wrong",
        origin: "http://127.0.0.1:3000"
      }, secrets))
      expect(Result.isFailure(invalidCsrf)).toBe(true)
      if (Result.isFailure(invalidCsrf)) expect(invalidCsrf.failure._tag).toBe("ForbiddenApiError")
      yield* authorizeOwnerRequest({ ...base, origin: "http://127.0.0.1:3000" }, secrets)
    }))

  it.effect("requires the URL-fragment bootstrap secret and exact local origin", () =>
    Effect.gen(function*() {
      const secrets = yield* makeSecrets()
      const invalid = yield* Effect.result(authorizeBootstrapRequest({
        authorization: "Bearer wrong",
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000"
      }, secrets))
      expect(Result.isFailure(invalid)).toBe(true)
      yield* authorizeBootstrapRequest({
        authorization: "Bearer bootstrap-secret",
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000"
      }, secrets)
      const reused = yield* Effect.result(authorizeBootstrapRequest({
        authorization: "Bearer bootstrap-secret",
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000"
      }, secrets))
      expect(Result.isFailure(reused)).toBe(true)
      const url = ownerSessionUrl("127.0.0.1", 3000, secrets)
      expect(url).toContain("#bootstrap_token=bootstrap-secret")
      expect(url).not.toContain("owner-secret")
      expect(url).not.toContain("csrf-secret")
      expect(ownerSessionUrlForOrigin("http://localhost:5173", secrets)).toBe(
        "http://localhost:5173/#bootstrap_token=bootstrap-secret"
      )
      const cookie = ownerSessionCookie(secrets)
      expect(cookie).toContain("HttpOnly")
      expect(cookie).toContain("Path=/api")
      expect(cookie).not.toContain("Domain=")
    }))

  it.effect("starts bootstrap expiry only after server readiness", () =>
    Effect.gen(function*() {
      const delayed = yield* makeSecrets(false)
      yield* TestClock.adjust("61 seconds")
      const inactive = yield* Effect.result(authorizeBootstrapRequest({
        authorization: "Bearer bootstrap-secret",
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000"
      }, delayed))
      expect(Result.isFailure(inactive)).toBe(true)

      yield* activateOwnerSessionBootstrap(delayed)
      yield* authorizeBootstrapRequest({
        authorization: "Bearer bootstrap-secret",
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000"
      }, delayed)

      const expired = yield* makeSecrets(false)
      yield* activateOwnerSessionBootstrap(expired)
      yield* TestClock.adjust("61 seconds")
      const afterLifetime = yield* Effect.result(authorizeBootstrapRequest({
        authorization: "Bearer bootstrap-secret",
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000"
      }, expired))
      expect(Result.isFailure(afterLifetime)).toBe(true)
      if (Result.isFailure(afterLifetime)) expect(afterLifetime.failure._tag).toBe("UnauthorizedApiError")
    }))

  it.effect("rejects the bootstrap token at the exact expiry instant", () =>
    Effect.gen(function*() {
      const justBeforeExpiry = yield* makeSecrets(false)
      yield* activateOwnerSessionBootstrap(justBeforeExpiry)
      yield* TestClock.adjust(Duration.millis(59_999))
      yield* authorizeBootstrapRequest({
        authorization: "Bearer bootstrap-secret",
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000"
      }, justBeforeExpiry)

      const atExpiry = yield* makeSecrets(false)
      yield* activateOwnerSessionBootstrap(atExpiry)
      yield* TestClock.adjust(Duration.seconds(60))
      const result = yield* Effect.result(authorizeBootstrapRequest({
        authorization: "Bearer bootstrap-secret",
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000"
      }, atExpiry))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure._tag).toBe("UnauthorizedApiError")
    }))

  it.effect("allows loopback listeners and rejects peer-facing hostnames", () =>
    Effect.gen(function*() {
      expect(yield* requireLoopbackHostname("127.0.0.1")).toBe("127.0.0.1")
      expect(yield* requireLoopbackOrigin("http://localhost:5173")).toBe("http://localhost:5173")
      const result = yield* Effect.result(requireLoopbackHostname("0.0.0.0"))
      expect(Result.isFailure(result)).toBe(true)
    }))

  it.effect("gates and audits decoded differences and blob reads before provider execution", () =>
    Effect.gen(function*() {
      const deniedCalls = yield* Ref.make({ blob: 0, differences: 0 })
      const deniedAudit = yield* Ref.make<ReadonlyArray<NewAuditLogEntry>>([])
      const denied = yield* makeTestPermissionedReadClient("deny", deniedCalls, deniedAudit)
      const differenceRequest = {
        account: readAccount,
        repositoryName: Domain.RepositoryName.make("payments"),
        beforeCommitSpecifier: ReadClient.CodeCommitCommitId.make("a".repeat(40)),
        afterCommitSpecifier: ReadClient.CodeCommitCommitId.make("b".repeat(40))
      }
      const blobRequest = {
        account: readAccount,
        repositoryName: Domain.RepositoryName.make("payments"),
        blobId: ReadClient.CodeCommitBlobId.make("c".repeat(40))
      }

      expect(Result.isFailure(yield* Effect.result(Stream.runDrain(denied.streamChangedFiles(differenceRequest)))))
        .toBe(true)
      expect(Result.isFailure(yield* Effect.result(denied.getBlob(blobRequest)))).toBe(true)
      expect(yield* Ref.get(deniedCalls)).toEqual({ blob: 0, differences: 0 })
      expect((yield* Ref.get(deniedAudit)).map(({ operation, permissionState }) => ({
        operation,
        permissionState
      }))).toEqual([
        { operation: "getDifferences", permissionState: "denied" },
        { operation: "getBlob", permissionState: "denied" }
      ])

      const allowedCalls = yield* Ref.make({ blob: 0, differences: 0 })
      const allowedAudit = yield* Ref.make<ReadonlyArray<NewAuditLogEntry>>([])
      const allowed = yield* makeTestPermissionedReadClient("always_allow", allowedCalls, allowedAudit)
      yield* Stream.runDrain(allowed.streamChangedFiles(differenceRequest))
      yield* allowed.getBlob(blobRequest)
      expect(yield* Ref.get(allowedCalls)).toEqual({ blob: 1, differences: 1 })
      expect((yield* Ref.get(allowedAudit)).map(({ operation, permissionState }) => ({
        operation,
        permissionState
      }))).toEqual([
        { operation: "getDifferences", permissionState: "always_allowed" },
        { operation: "getBlob", permissionState: "always_allowed" }
      ])

      const failedCalls = yield* Ref.make({ blob: 0, differences: 0 })
      const failedAudit = yield* Ref.make<ReadonlyArray<NewAuditLogEntry>>([])
      const failedInner: ReadClient.CodeCommitReadClientService = {
        ...makeObservedReadClient(failedCalls),
        getBlob: () =>
          Ref.update(failedCalls, (count) => ({ ...count, blob: count.blob + 1 })).pipe(
            Effect.flatMap(() => Effect.fail(new ReadClient.CodeCommitReadNotFoundError({ operation: "get-blob" })))
          )
      }
      const failed = yield* makePermissionedReadClient(failedInner).pipe(
        Effect.provideService(PermissionService, makePermissionService("always_allow")),
        Effect.provideService(PermissionGate, PermissionGate.of({ request: () => unused() })),
        Effect.provideService(AuditLogRepo, makeAuditLog(failedAudit))
      )
      expect(Result.isFailure(yield* Effect.result(failed.getBlob(blobRequest)))).toBe(true)
      expect(yield* Ref.get(failedCalls)).toEqual({ blob: 1, differences: 0 })
      expect((yield* Ref.get(failedAudit)).map(({ permissionState }) => permissionState)).toEqual([
        "always_allowed"
      ])
    }))

  it.effect("preserves prompted denial and timeout outcomes before provider execution", () =>
    Effect.gen(function*() {
      const blobRequest = {
        account: readAccount,
        repositoryName: Domain.RepositoryName.make("payments"),
        blobId: ReadClient.CodeCommitBlobId.make("c".repeat(40))
      }

      const failureFixtures: ReadonlyArray<{
        readonly reason: "denied" | "timeout"
        readonly expectedAudit: NewAuditLogEntry["permissionState"]
        readonly expectedUpdates: ReadonlyArray<readonly [string, PermissionState]>
      }> = [
        { reason: "denied", expectedAudit: "denied", expectedUpdates: [["getBlob", "deny"]] },
        { reason: "timeout", expectedAudit: "timed_out", expectedUpdates: [] }
      ]
      for (const fixture of failureFixtures) {
        const calls = yield* Ref.make({ blob: 0, differences: 0 })
        const auditEntries = yield* Ref.make<ReadonlyArray<NewAuditLogEntry>>([])
        const permissionUpdates = yield* Ref.make<ReadonlyArray<readonly [string, PermissionState]>>([])
        const client = yield* makeTestPermissionedReadClient(
          "allow",
          calls,
          auditEntries,
          () => Effect.fail(new PermissionDeniedError({ operation: "getBlob", reason: fixture.reason })),
          permissionUpdates
        )

        expect(Result.isFailure(yield* Effect.result(client.getBlob(blobRequest)))).toBe(true)
        expect(yield* Ref.get(calls)).toEqual({ blob: 0, differences: 0 })
        expect(yield* Ref.get(permissionUpdates)).toEqual(fixture.expectedUpdates)
        expect((yield* Ref.get(auditEntries)).map(({ permissionState }) => permissionState)).toEqual([
          fixture.expectedAudit
        ])
      }

      const allowedCalls = yield* Ref.make({ blob: 0, differences: 0 })
      const allowedAudit = yield* Ref.make<ReadonlyArray<NewAuditLogEntry>>([])
      const allowedUpdates = yield* Ref.make<ReadonlyArray<readonly [string, PermissionState]>>([])
      const allowed = yield* makeTestPermissionedReadClient(
        "allow",
        allowedCalls,
        allowedAudit,
        () => Effect.succeed("allow_once"),
        allowedUpdates
      )

      yield* allowed.getBlob(blobRequest)
      expect(yield* Ref.get(allowedCalls)).toEqual({ blob: 1, differences: 0 })
      expect(yield* Ref.get(allowedUpdates)).toEqual([])
      expect((yield* Ref.get(allowedAudit)).map(({ permissionState }) => permissionState)).toEqual(["allowed"])
    }))

  it.effect("gates and audits every paginated differences provider request", () =>
    Effect.gen(function*() {
      const differenceRequest = {
        account: readAccount,
        repositoryName: Domain.RepositoryName.make("payments"),
        beforeCommitSpecifier: ReadClient.CodeCommitCommitId.make("a".repeat(40)),
        afterCommitSpecifier: ReadClient.CodeCommitCommitId.make("b".repeat(40))
      }
      const pageCalls = yield* Ref.make(0)
      const gateCalls = yield* Ref.make(0)
      const auditEntries = yield* Ref.make<ReadonlyArray<NewAuditLogEntry>>([])
      const inner: ReadClient.CodeCommitReadClientService = {
        ...makeObservedReadClient(yield* Ref.make({ blob: 0, differences: 0 })),
        getChangedFilesPage: ({ nextToken }) =>
          Ref.update(pageCalls, (count) => count + 1).pipe(
            Effect.as(
              new ReadClient.CodeCommitChangedFilesPage({
                files: [changedFile],
                nextToken: nextToken === null ? ReadClient.CodeCommitPageToken.make("page-2") : null,
                providerPageLimit: 100
              })
            )
          )
      }
      const client = yield* makePermissionedReadClient(inner).pipe(
        Effect.provideService(PermissionService, makePermissionService("allow")),
        Effect.provideService(
          PermissionGate,
          PermissionGate.of({
            request: () => Ref.update(gateCalls, (count) => count + 1).pipe(Effect.as("allow_once"))
          })
        ),
        Effect.provideService(AuditLogRepo, makeAuditLog(auditEntries))
      )

      expect(Array.from(yield* Stream.runCollect(client.streamChangedFiles(differenceRequest)))).toEqual([
        changedFile,
        changedFile
      ])
      expect(yield* Ref.get(pageCalls)).toBe(2)
      expect(yield* Ref.get(gateCalls)).toBe(2)
      expect((yield* Ref.get(auditEntries)).map(({ operation, permissionState }) => ({
        operation,
        permissionState
      }))).toEqual([
        { operation: "getDifferences", permissionState: "allowed" },
        { operation: "getDifferences", permissionState: "allowed" }
      ])
    }))

  it.effect("gates and audits the PR list page and every hydrated PR detail call", () =>
    Effect.gen(function*() {
      const request: Parameters<ReadClient.CodeCommitReadClientService["listPullRequestsPage"]>[0] = {
        account: readAccount,
        repositoryName: Domain.RepositoryName.make("payments"),
        status: "OPEN",
        nextToken: null
      }
      const pullRequestIdFixtures: ReadonlyArray<ReadonlyArray<Domain.PullRequestId>> = [
        [Domain.PullRequestId.make("1"), Domain.PullRequestId.make("2")],
        []
      ]

      for (const pullRequestIds of pullRequestIdFixtures) {
        const calls = yield* Ref.make({ list: 0, detail: 0 })
        const gateCalls = yield* Ref.make(0)
        const auditEntries = yield* Ref.make<ReadonlyArray<NewAuditLogEntry>>([])
        const inner: ReadClient.CodeCommitReadClientService = {
          ...makeObservedReadClient(yield* Ref.make({ blob: 0, differences: 0 })),
          listPullRequestIdsPage: () =>
            Ref.update(calls, (count) => ({ ...count, list: count.list + 1 })).pipe(
              Effect.as(new ReadClient.CodeCommitPullRequestIdsPage({ pullRequestIds, nextToken: null }))
            ),
          listPullRequestsPage: () => Effect.die("permissioned client must hydrate gated detail calls"),
          getPullRequest: ({ pullRequestId }) =>
            Ref.update(calls, (count) => ({ ...count, detail: count.detail + 1 })).pipe(
              Effect.as(
                new ReadClient.CodeCommitPullRequestRevision({
                  pullRequestId,
                  revisionId: `revision-${pullRequestId}`,
                  repositoryName: request.repositoryName,
                  title: `PR ${pullRequestId}`,
                  authorArn: null,
                  status: "OPEN",
                  sourceReference: `refs/heads/feature-${pullRequestId}`,
                  destinationReference: "refs/heads/main",
                  sourceCommit: ReadClient.CodeCommitCommitId.make(`head-${pullRequestId}`),
                  destinationCommit: ReadClient.CodeCommitCommitId.make("base"),
                  mergeBase: null,
                  creationDate: new Date(0),
                  lastActivityDate: new Date(1)
                })
              )
            )
        }
        const client = yield* makePermissionedReadClient(inner).pipe(
          Effect.provideService(PermissionService, makePermissionService("allow")),
          Effect.provideService(
            PermissionGate,
            PermissionGate.of({
              request: () => Ref.update(gateCalls, (count) => count + 1).pipe(Effect.as("allow_once"))
            })
          ),
          Effect.provideService(AuditLogRepo, makeAuditLog(auditEntries))
        )

        const page = yield* client.listPullRequestsPage(request)
        expect(page.pullRequests.map(({ pullRequestId }) => pullRequestId)).toEqual(pullRequestIds)
        expect(yield* Ref.get(calls)).toEqual({ list: 1, detail: pullRequestIds.length })
        expect(yield* Ref.get(gateCalls)).toBe(1 + pullRequestIds.length)
        expect((yield* Ref.get(auditEntries)).map(({ operation }) => operation)).toEqual([
          "getPullRequests",
          ...pullRequestIds.map(() => "getPullRequest")
        ])
      }
    }))

  it("never emits the persisted sandbox password in list or SSE projections", () => {
    const encoded = encodeSandbox({
      id: "sbx-1",
      pullRequestId: "42",
      awsAccountId: "123456789012",
      repositoryName: "repo",
      sourceBranch: "feature",
      accessPassword: "server-private-password",
      containerId: "container",
      port: 18080,
      workspacePath: "/private/workspace",
      status: "running",
      statusDetail: null,
      logs: null,
      error: null,
      createdAt: "2026-08-10T00:00:00.000Z",
      lastActivityAt: "2026-08-10T00:00:00.000Z"
    })
    expect(encoded).not.toHaveProperty("accessPassword")
    expect(encoded).not.toHaveProperty("workspacePath")
  })
})
