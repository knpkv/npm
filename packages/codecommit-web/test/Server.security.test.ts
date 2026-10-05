import { NodeCrypto } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigService, Domain, ReadClient, ReviewClient } from "@knpkv/codecommit-core"
import * as ChildEnv from "@knpkv/codecommit-core/ChildEnv.js"
import { AwsApiError, PermissionDeniedError } from "@knpkv/codecommit-core/Errors.js"
import { AuditLogRepo, type NewAuditLogEntry } from "@knpkv/codecommit-core/PermissionService/AuditLog.js"
import { PermissionService, type PermissionState } from "@knpkv/codecommit-core/PermissionService/index.js"
import { PermissionGate } from "@knpkv/codecommit-core/PermissionService/PermissionGate.js"
import {
  Cause,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Ref,
  Result,
  Stream,
  SubscriptionRef
} from "effect"
import { HttpServerResponse } from "effect/http"
import { CodeCommitApi, OwnerSessionAuth, type PullRequestDiffContentResponse } from "../src/server/Api.js"
import { commitConfigMutation } from "../src/server/handlers/config-live.js"
import { encodeClientVisibleCommentLocations, makeDiffContentResponse } from "../src/server/handlers/prs-live.js"
import { encodeSandbox } from "../src/server/handlers/sandbox-live.js"
import { makeOwnerSession } from "../src/server/internal/OwnerSession.js"
import { makePermissionedReadClient } from "../src/server/internal/PermissionedReadClient.js"
import {
  resolveCodeCommitPublicOrigin,
  resolveCodeCommitPublicOriginForBind
} from "../src/server/internal/PublicOrigin.js"
import { makeRelayFindingPublisher } from "../src/server/review/RelayFindingPublisher.js"
import { makeServer } from "../src/server/Server.js"

const authorityOrigin = "http://127.0.0.1:3000"

const unused = <A>(): Effect.Effect<A> => Effect.die("unused read-client operation")

type PermissionStateResolver = (operation: string) => PermissionState

const fixedPermissionState = (state: PermissionState): PermissionStateResolver => () => state

const makePermissionService = (
  resolveState: PermissionStateResolver,
  updates?: Ref.Ref<ReadonlyArray<readonly [string, PermissionState]>>
): PermissionService["Service"] => ({
  check: (operation) => Effect.succeed(resolveState(operation)),
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
    Effect.provideService(PermissionService, makePermissionService(fixedPermissionState(state), permissionUpdates)),
    Effect.provideService(PermissionGate, PermissionGate.of({ request: gateRequest })),
    Effect.provideService(AuditLogRepo, makeAuditLog(auditEntries))
  )
})

describe("CodeCommit web security boundary", () => {
  it.effect("issues independent redacted 256-bit credentials for each browser proof", () =>
    Effect.gen(function*() {
      const counter = yield* Ref.make(1)
      const pairingCrypto = Crypto.Crypto.of({
        randomBytes: (size) =>
          Ref.getAndUpdate(counter, (value) => value + 1).pipe(
            Effect.map((value) => new Uint8Array(size).fill(value))
          ),
        randomUUIDv4: Effect.succeed("00000000-0000-4000-8000-000000000000"),
        randomUUIDv7: Effect.succeed("01900000-0000-7000-8000-000000000000"),
        digest: (_algorithm, bytes) => Effect.succeed(new Uint8Array(32).fill(bytes[0] ?? 0))
      })
      const session = yield* makeOwnerSession(authorityOrigin).pipe(
        Effect.provideService(Crypto.Crypto, pairingCrypto)
      )
      const code = yield* session.mintBootstrapCode
      const owner = decodeURIComponent(session.sessionCookie.split(";")[0]?.slice("cc_owner=".length) ?? "")
      const csrf = session.writes._tag === "Csrf" ? Redacted.value(session.writes.token) : ""
      const values = [owner, csrf, Redacted.value(code)]
      expect(values.every((value) => /^[0-9a-f]{64}$/u.test(value))).toBe(true)
      expect(new Set(values).size).toBe(3)
    }))

  it.effect("keeps a committed config mutation successful when its refresh fails", () =>
    Effect.gen(function*() {
      const originalReview = ConfigService.defaultReviewConfig
      const updatedReview = {
        defaultProfileId: "quick",
        profiles: [{ id: "quick", name: "Quick review", kind: "review", skillIds: [] }]
      } satisfies ConfigService.ReviewConfig
      const persisted = yield* Ref.make(originalReview)
      const refreshCalls = yield* Ref.make(0)
      const refreshState = yield* SubscriptionRef.make<
        { readonly status: string; readonly error?: string | undefined }
      >(
        { status: "idle" }
      )
      const refreshFailure = Ref.update(refreshCalls, (count) => count + 1).pipe(
        Effect.andThen(Effect.die("refresh defect"))
      )

      const committed = yield* commitConfigMutation(
        Ref.set(persisted, updatedReview),
        refreshFailure,
        refreshState,
        "save"
      ).pipe(Effect.result)

      expect(Result.isSuccess(committed)).toBe(true)
      if (Result.isSuccess(committed)) expect(committed.success.refreshStatus).toBe("failed")
      expect(yield* Ref.get(persisted)).toEqual(updatedReview)
      expect(yield* Ref.get(refreshCalls)).toBe(1)

      const rejected = yield* commitConfigMutation(
        Effect.fail("write rejected"),
        Ref.update(refreshCalls, (count) => count + 1),
        refreshState,
        "save"
      ).pipe(Effect.result)

      expect(Result.isFailure(rejected)).toBe(true)
      expect(yield* Ref.get(persisted)).toEqual(updatedReview)
      expect(yield* Ref.get(refreshCalls)).toBe(1)

      const stateFailure = yield* commitConfigMutation(
        Effect.void,
        SubscriptionRef.set(refreshState, { status: "error", error: "provider timeout" }),
        refreshState,
        "reset"
      )
      expect(stateFailure.refreshStatus).toBe("failed")

      const refreshed = yield* commitConfigMutation(
        Effect.void,
        SubscriptionRef.set(refreshState, { status: "idle" }),
        refreshState,
        "save"
      )
      expect(refreshed.refreshStatus).toBe("refreshed")

      const interrupted = yield* commitConfigMutation(
        Effect.void,
        Effect.interrupt,
        refreshState,
        "save"
      ).pipe(Effect.exit)
      expect(Exit.isFailure(interrupted)).toBe(true)
      if (Exit.isFailure(interrupted)) expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true)
    }))

  it("removes only owned Relay reconciliation markers from client-visible comments", () => {
    const token = "a".repeat(64)
    const encoded = encodeClientVisibleCommentLocations([
      {
        comments: [
          {
            root: new Domain.PRComment({
              id: Domain.CommentId.make("comment-1"),
              content: `Finding\n\n<!-- knpkv-codecommit-review:${token} -->`,
              author: "relay",
              creationDate: new Date("2026-08-12T10:00:00.000Z"),
              deleted: false
            }),
            replies: [
              {
                root: new Domain.PRComment({
                  id: Domain.CommentId.make("comment-2"),
                  content: "Keep unrelated <!-- review:markup --> unchanged",
                  author: "reviewer",
                  creationDate: new Date("2026-08-12T10:01:00.000Z"),
                  deleted: false
                }),
                replies: []
              }
            ]
          }
        ]
      }
    ])

    const serialized = JSON.stringify(encoded)
    expect(serialized).not.toContain(token)
    expect(encoded[0]?.comments[0]?.root.content).toBe("Finding")
    expect(encoded[0]?.comments[0]?.replies[0]?.root.content).toBe(
      "Keep unrelated <!-- review:markup --> unchanged"
    )
  })

  it.effect("permission-gates and audits Relay publication before the provider write", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const auditEntries = yield* Ref.make<ReadonlyArray<NewAuditLogEntry>>([])
      const reviewClient = ReviewClient.CodeCommitReviewClient.of({
        execute: () =>
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.as(new ReviewClient.CodeCommitReviewReceipt({ operationId: "comment:1", summary: "posted" }))
          ),
        preflight: () => unused(),
        reconcile: () => unused()
      })
      const publisher = yield* makeRelayFindingPublisher().pipe(
        Effect.provideService(ReviewClient.CodeCommitReviewClient, reviewClient),
        Effect.provideService(PermissionService, makePermissionService(fixedPermissionState("deny"))),
        Effect.provideService(PermissionGate, PermissionGate.of({ request: () => unused() })),
        Effect.provideService(AuditLogRepo, makeAuditLog(auditEntries))
      )
      const result = yield* publisher.post({
        _tag: "comment",
        target: {
          account: readAccount,
          repositoryName: Domain.RepositoryName.make("payments"),
          pullRequestId: Domain.PullRequestId.make("42"),
          revisionId: "revision-1",
          sourceCommit: ReadClient.CodeCommitCommitId.make("head"),
          destinationCommit: ReadClient.CodeCommitCommitId.make("base"),
          destinationReference: "refs/heads/main"
        },
        content: "Finding",
        clientRequestToken: "relay-finding-1"
      }).pipe(Effect.result)

      expect(Result.isFailure(result)).toBe(true)
      expect(yield* Ref.get(calls)).toBe(0)
      expect(yield* Ref.get(auditEntries)).toEqual([
        expect.objectContaining({ operation: "postPullRequestComment", permissionState: "denied" })
      ])
    }))

  it.effect("identifies the exact AWS target in Relay publication prompts", () =>
    Effect.gen(function*() {
      const prompts = yield* Ref.make<ReadonlyArray<string>>([])
      const auditEntries = yield* Ref.make<ReadonlyArray<NewAuditLogEntry>>([])
      const reviewClient = ReviewClient.CodeCommitReviewClient.of({
        execute: () =>
          Effect.succeed(new ReviewClient.CodeCommitReviewReceipt({ operationId: "comment:1", summary: "posted" })),
        preflight: () => unused(),
        reconcile: () => unused()
      })
      const publisher = yield* makeRelayFindingPublisher().pipe(
        Effect.provideService(ReviewClient.CodeCommitReviewClient, reviewClient),
        Effect.provideService(PermissionService, makePermissionService(fixedPermissionState("allow"))),
        Effect.provideService(
          PermissionGate,
          PermissionGate.of({
            request: ({ context }) =>
              Ref.update(prompts, (current) => [...current, context]).pipe(Effect.as("allow_once"))
          })
        ),
        Effect.provideService(AuditLogRepo, makeAuditLog(auditEntries))
      )
      const action = (profile: string, region: string, repositoryName: string) =>
        ({
          _tag: "comment",
          target: {
            account: {
              profile: Domain.AwsProfileName.make(profile),
              region: Domain.AwsRegion.make(region)
            },
            repositoryName: Domain.RepositoryName.make(repositoryName),
            pullRequestId: Domain.PullRequestId.make("42"),
            revisionId: "revision-1",
            sourceCommit: ReadClient.CodeCommitCommitId.make("head"),
            destinationCommit: ReadClient.CodeCommitCommitId.make("base"),
            destinationReference: "refs/heads/main"
          },
          content: "Finding",
          clientRequestToken: `relay-${profile}-${repositoryName}`
        }) satisfies Extract<ReviewClient.CodeCommitReviewAction, { readonly _tag: "comment" }>

      yield* publisher.post(action("production", "eu-west-1", "payments"))
      yield* publisher.post(action("staging", "us-east-1", "ledger"))

      expect(yield* Ref.get(prompts)).toEqual([
        "Post Relay finding to production/eu-west-1/payments PR #42",
        "Post Relay finding to staging/us-east-1/ledger PR #42"
      ])
    }))

  it.effect("records provider success and failure outcomes for Relay publication", () =>
    Effect.gen(function*() {
      const auditEntries = yield* Ref.make<ReadonlyArray<NewAuditLogEntry>>([])
      const attempts = yield* Ref.make(0)
      const reviewClient = ReviewClient.CodeCommitReviewClient.of({
        execute: () =>
          Ref.getAndUpdate(attempts, (attempt) => attempt + 1).pipe(
            Effect.flatMap((attempt) =>
              attempt === 0
                ? Effect.succeed(
                  new ReviewClient.CodeCommitReviewReceipt({ operationId: "comment:1", summary: "posted" })
                )
                : Effect.fail(
                  new AwsApiError({
                    operation: "postPullRequestComment",
                    profile: readAccount.profile,
                    region: readAccount.region,
                    cause: new Error("provider unavailable")
                  })
                )
            )
          ),
        preflight: () => unused(),
        reconcile: () => unused()
      })
      const publisher = yield* makeRelayFindingPublisher().pipe(
        Effect.provideService(ReviewClient.CodeCommitReviewClient, reviewClient),
        Effect.provideService(PermissionService, makePermissionService(fixedPermissionState("always_allow"))),
        Effect.provideService(PermissionGate, PermissionGate.of({ request: () => unused() })),
        Effect.provideService(AuditLogRepo, makeAuditLog(auditEntries))
      )
      const action = {
        _tag: "comment",
        target: {
          account: readAccount,
          repositoryName: Domain.RepositoryName.make("payments"),
          pullRequestId: Domain.PullRequestId.make("42"),
          revisionId: "revision-1",
          sourceCommit: ReadClient.CodeCommitCommitId.make("head"),
          destinationCommit: ReadClient.CodeCommitCommitId.make("base"),
          destinationReference: "refs/heads/main"
        },
        content: "Finding",
        clientRequestToken: "relay-finding-1"
      } satisfies Extract<ReviewClient.CodeCommitReviewAction, { readonly _tag: "comment" }>

      yield* publisher.post(action)
      expect(Exit.isFailure(yield* Effect.exit(publisher.post(action)))).toBe(true)
      expect((yield* Ref.get(auditEntries)).map(({ context }) => context)).toEqual([
        "Post Relay finding to production/eu-west-1/payments PR #42 · provider succeeded",
        "Post Relay finding to production/eu-west-1/payments PR #42 · provider failed"
      ])
    }))

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

  // The policy itself is tested in @knpkv/browser-pairing; these cover CodeCommit web's wiring of it.
  it.layer(NodeCrypto.layer)("owner session wiring", (it) => {
    it.effect("checks requests against the bound origin, which the dev proxy rewrites Origin to", () =>
      Effect.gen(function*() {
        const session = yield* makeOwnerSession(authorityOrigin)
        expect(session.browserOrigin).toBe(authorityOrigin)
        expect(session.writes._tag).toBe("Csrf")
        expect(session.sessionCookie).toMatch(/^cc_owner=/u)
        const spend = (origin: string) =>
          Effect.gen(function*() {
            const code = yield* session.mintBootstrapCode
            return yield* Effect.result(session.authorizeBootstrap({
              authorization: `Bearer ${Redacted.value(code)}`,
              origin
            }))
          })
        expect(Result.isFailure(yield* spend("http://localhost:5173"))).toBe(true)
        expect(Result.isSuccess(yield* spend(authorityOrigin))).toBe(true)
      }))

    it.effect("refuses to print a bootstrap URL on a foreign origin before binding", () =>
      Effect.gen(function*() {
        const security = yield* makeOwnerSession(authorityOrigin)
        for (const publicOrigin of ["https://example.com", "http://localhost:4173", `${authorityOrigin}/app`]) {
          // Fails before any service is used; the host environment only satisfies the layer's type.
          const built = yield* Effect.exit(Effect.scoped(Layer.build(makeServer({ port: 0, publicOrigin, security }))))
            .pipe(Effect.provideService(ChildEnv.HostEnvironment, ChildEnv.HostEnvironment.of({ variables: {} })))
          expect(Exit.isFailure(built) && Cause.squash(built.cause)).toMatchObject({
            _tag: "UnsafeLoopbackAddressError"
          })
        }
      }))

    it.effect("refuses browser-marked cross-site reads of the API", () =>
      Effect.gen(function*() {
        const session = yield* makeOwnerSession(authorityOrigin)
        const credential = decodeURIComponent(session.sessionCookie.split(";")[0]?.slice("cc_owner=".length) ?? "")
        const read = { credential, csrfToken: undefined, method: "GET", origin: undefined }
        expect(Result.isSuccess(yield* Effect.result(session.authorizeRequest({ ...read, fetchSite: undefined }))))
          .toBe(true)
        expect(Result.isSuccess(yield* Effect.result(session.authorizeRequest({ ...read, fetchSite: "same-origin" }))))
          .toBe(true)
        const crossSite = yield* Effect.result(session.authorizeRequest({ ...read, fetchSite: "cross-site" }))
        expect(Result.isFailure(crossSite) && crossSite.failure._tag).toBe("OwnerSessionForbiddenError")
      }))
  })

  it.effect("only advertises the direct server or the supported Vite proxy origin", () =>
    Effect.gen(function*() {
      expect(yield* resolveCodeCommitPublicOrigin("http://localhost:5173", 3001)).toBe("http://localhost:5173")
      expect(yield* resolveCodeCommitPublicOrigin(undefined, 3000)).toBe(authorityOrigin)
      const unsupported = yield* Effect.result(resolveCodeCommitPublicOrigin("http://localhost:4173", 3000))
      expect(Result.isFailure(unsupported) && unsupported.failure._tag).toBe("UnsafeLoopbackAddressError")
      expect(yield* resolveCodeCommitPublicOriginForBind("http://localhost:5173", 3000, 3001)).toBe(
        "http://127.0.0.1:3001"
      )
      expect(yield* resolveCodeCommitPublicOriginForBind("http://localhost:5173", 3000, 3000)).toBe(
        "http://localhost:5173"
      )
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
        Effect.provideService(PermissionService, makePermissionService(fixedPermissionState("always_allow"))),
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
        Effect.provideService(PermissionService, makePermissionService(fixedPermissionState("allow"))),
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

      const repeatedCalls = yield* Ref.make(0)
      const repeatedAudit = yield* Ref.make<ReadonlyArray<NewAuditLogEntry>>([])
      const repeatedToken = ReadClient.CodeCommitPageToken.make("repeated-page")
      const repeatedClient = yield* makePermissionedReadClient({
        ...inner,
        getChangedFilesPage: () =>
          Ref.update(repeatedCalls, (count) => count + 1).pipe(
            Effect.as(
              new ReadClient.CodeCommitChangedFilesPage({
                files: [],
                nextToken: repeatedToken,
                providerPageLimit: 100
              })
            )
          )
      }).pipe(
        Effect.provideService(PermissionService, makePermissionService(fixedPermissionState("always_allow"))),
        Effect.provideService(PermissionGate, PermissionGate.of({ request: () => unused() })),
        Effect.provideService(AuditLogRepo, makeAuditLog(repeatedAudit))
      )

      const repeatedResult = yield* Effect.result(Stream.runDrain(repeatedClient.streamChangedFiles(differenceRequest)))
      expect(Result.isFailure(repeatedResult)).toBe(true)
      if (Result.isFailure(repeatedResult)) {
        expect(repeatedResult.failure).toMatchObject({
          _tag: "CodeCommitMalformedResponseError",
          operation: "GetDifferences",
          diagnosticCode: "repeated-page-token"
        })
      }
      expect(yield* Ref.get(repeatedCalls)).toBe(2)
      expect((yield* Ref.get(repeatedAudit)).map(({ operation }) => operation)).toEqual([
        "getDifferences",
        "getDifferences"
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
          Effect.provideService(
            PermissionService,
            makePermissionService((operation) => operation === "listPullRequests" ? "always_allow" : "allow")
          ),
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
        expect(yield* Ref.get(gateCalls)).toBe(pullRequestIds.length)
        expect((yield* Ref.get(auditEntries)).map(({ operation }) => operation)).toEqual([
          "listPullRequests",
          ...pullRequestIds.map(() => "getPullRequest")
        ])
      }
    }))

  it.effect("serializes hydrated PR permission prompts", () =>
    Effect.gen(function*() {
      const request: Parameters<ReadClient.CodeCommitReadClientService["listPullRequestsPage"]>[0] = {
        account: readAccount,
        repositoryName: Domain.RepositoryName.make("payments"),
        status: "OPEN",
        nextToken: null
      }
      const pullRequestIds = [Domain.PullRequestId.make("1"), Domain.PullRequestId.make("2")]
      const promptStarted = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
      const promptRelease = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
      const promptCount = yield* Ref.make(0)
      const detailCalls = yield* Ref.make(0)
      const auditEntries = yield* Ref.make<ReadonlyArray<NewAuditLogEntry>>([])
      const inner: ReadClient.CodeCommitReadClientService = {
        ...makeObservedReadClient(yield* Ref.make({ blob: 0, differences: 0 })),
        listPullRequestIdsPage: () =>
          Effect.succeed(new ReadClient.CodeCommitPullRequestIdsPage({ pullRequestIds, nextToken: null })),
        listPullRequestsPage: () => Effect.die("permissioned client must hydrate gated detail calls"),
        getPullRequest: ({ pullRequestId }) =>
          Ref.update(detailCalls, (count) => count + 1).pipe(
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
        Effect.provideService(
          PermissionService,
          makePermissionService((operation) => operation === "listPullRequests" ? "always_allow" : "allow")
        ),
        Effect.provideService(
          PermissionGate,
          PermissionGate.of({
            request: () =>
              Ref.getAndUpdate(promptCount, (count) => count + 1).pipe(
                Effect.flatMap((index) =>
                  Deferred.succeed(promptStarted[index]!, undefined).pipe(
                    Effect.andThen(Deferred.await(promptRelease[index]!)),
                    Effect.andThen(Effect.succeed("allow_once"))
                  )
                )
              )
          })
        ),
        Effect.provideService(AuditLogRepo, makeAuditLog(auditEntries))
      )

      const fiber = yield* client.listPullRequestsPage(request).pipe(Effect.forkChild)
      yield* Deferred.await(promptStarted[0]!)
      expect(yield* Ref.get(promptCount)).toBe(1)
      expect(yield* Ref.get(detailCalls)).toBe(0)

      yield* Deferred.succeed(promptRelease[0]!, undefined)
      yield* Deferred.await(promptStarted[1]!)
      expect(yield* Ref.get(promptCount)).toBe(2)
      expect(yield* Ref.get(detailCalls)).toBe(1)

      yield* Deferred.succeed(promptRelease[1]!, undefined)
      expect((yield* Fiber.join(fiber)).pullRequests.map(({ pullRequestId }) => pullRequestId)).toEqual(pullRequestIds)
      expect(yield* Ref.get(detailCalls)).toBe(2)
    }))

  it("never emits the persisted sandbox password in list or SSE projections", () => {
    const encoded = encodeSandbox({
      id: "sbx-1",
      pullRequestId: "42",
      awsAccountId: "123456789012",
      repositoryName: "repo",
      region: "eu-west-1",
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
