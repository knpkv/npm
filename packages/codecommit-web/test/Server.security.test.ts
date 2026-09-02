import { describe, expect, it } from "@effect/vitest"
import { CsrfToken, PairingCode, SessionToken } from "@knpkv/browser-pairing/schema"
import { ConfigService, Domain, ReadClient, ReviewClient } from "@knpkv/codecommit-core"
import { AwsApiError, PermissionDeniedError } from "@knpkv/codecommit-core/Errors.js"
import { AuditLogRepo, type NewAuditLogEntry } from "@knpkv/codecommit-core/PermissionService/AuditLog.js"
import { PermissionService, type PermissionState } from "@knpkv/codecommit-core/PermissionService/index.js"
import { PermissionGate } from "@knpkv/codecommit-core/PermissionService/PermissionGate.js"
import {
  Cause,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Redacted,
  Ref,
  Result,
  Schema,
  Stream,
  SubscriptionRef
} from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpServerResponse } from "effect/unstable/http"
import { CodeCommitApi, OwnerSessionAuth, type PullRequestDiffContentResponse } from "../src/server/Api.js"
import { commitConfigMutation } from "../src/server/handlers/config-live.js"
import { encodeClientVisibleCommentLocations, makeDiffContentResponse } from "../src/server/handlers/prs-live.js"
import { encodeSandbox } from "../src/server/handlers/sandbox-live.js"
import {
  activateOwnerSessionBootstrap,
  authorizeBootstrapRequest,
  authorizeOwnerRequest,
  makeOwnerSessionSecrets,
  ownerSessionCookie,
  type OwnerSessionSecretsContract,
  ownerSessionUrl,
  ownerSessionUrlForOrigin,
  requireLoopbackHostname,
  requireLoopbackOrigin,
  requireSupportedPublicOrigin
} from "../src/server/internal/OwnerSessionSecurity.js"
import { makePermissionedReadClient } from "../src/server/internal/PermissionedReadClient.js"
import { resolveCodeCommitBootstrapUrl, resolveCodeCommitPublicOrigin } from "../src/server/internal/PublicOrigin.js"
import { makeRelayFindingPublisher } from "../src/server/review/RelayFindingPublisher.js"

const ownerToken = "aa".repeat(32)
const csrfToken = "bb".repeat(32)
const bootstrapToken = "cc".repeat(32)
const authorityOrigin = "http://127.0.0.1:3000"
const sessionCredential = (value: string): SessionToken => Schema.decodeSync(SessionToken)(value)
const csrfCredential = (value: string): CsrfToken => Schema.decodeSync(CsrfToken)(value)
const pairingCredential = (value: string): PairingCode => Schema.decodeSync(PairingCode)(value)

const makeSecrets = Effect.fn("ServerSecurityTest.makeSecrets")(
  function*(active: boolean = true): Effect.fn.Return<OwnerSessionSecretsContract> {
    return {
      authorityOrigin,
      ownerToken: Redacted.make(sessionCredential(ownerToken)),
      csrfToken: Redacted.make(csrfCredential(csrfToken)),
      bootstrapToken: Redacted.make(pairingCredential(bootstrapToken)),
      bootstrapAvailable: yield* Ref.make(true),
      bootstrapAttemptState: yield* Ref.make({ failedAttempts: 0, inFlight: 0 }),
      bootstrapExpiresAtMillis: yield* Ref.make<number | undefined>(active ? Number.MAX_SAFE_INTEGER : undefined)
    }
  }
)

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
      const secrets = yield* makeOwnerSessionSecrets(authorityOrigin).pipe(
        Effect.provideService(Crypto.Crypto, pairingCrypto)
      )
      const values = [secrets.ownerToken, secrets.csrfToken, secrets.bootstrapToken]
        .map(Redacted.value)
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
        credential: ownerToken,
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
        credential: ownerToken,
        csrfToken,
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
        authorization: `Bearer ${bootstrapToken}`,
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000"
      }, secrets)
      const reused = yield* Effect.result(authorizeBootstrapRequest({
        authorization: `Bearer ${bootstrapToken}`,
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000"
      }, secrets))
      expect(Result.isFailure(reused)).toBe(true)
      const url = ownerSessionUrl("127.0.0.1", 3000, secrets)
      expect(url).toContain(`#bootstrap_token=${bootstrapToken}`)
      expect(url).not.toContain(ownerToken)
      expect(url).not.toContain(csrfToken)
      expect(ownerSessionUrlForOrigin("http://localhost:5173", secrets)).toBe(
        `http://localhost:5173/#bootstrap_token=${bootstrapToken}`
      )
      const cookie = ownerSessionCookie(secrets)
      expect(cookie).toContain("HttpOnly")
      expect(cookie).toContain("Path=/api")
      expect(cookie).not.toContain("Domain=")
    }))

  it.effect("uses configured authority for origin checks and bounds unauthenticated attempts", () =>
    Effect.gen(function*() {
      const secrets = yield* makeSecrets()
      yield* authorizeBootstrapRequest({
        authorization: `Bearer ${bootstrapToken}`,
        host: "attacker.example:3000",
        origin: authorityOrigin
      }, secrets)

      const crossOrigin = yield* makeSecrets()
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const failed = yield* Effect.result(authorizeBootstrapRequest({
          authorization: undefined,
          host: "127.0.0.1:3000",
          origin: "https://attacker.example"
        }, crossOrigin))
        expect(Result.isFailure(failed)).toBe(true)
        if (Result.isFailure(failed)) expect(failed.failure._tag).toBe("ForbiddenApiError")
      }
      expect((yield* Ref.get(crossOrigin.bootstrapAttemptState)).failedAttempts).toBe(0)
      yield* authorizeBootstrapRequest({
        authorization: `Bearer ${bootstrapToken}`,
        host: "attacker.example:3000",
        origin: authorityOrigin
      }, crossOrigin)

      const limited = yield* makeSecrets()
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const failed = yield* Effect.result(authorizeBootstrapRequest({
          authorization: "Bearer invalid",
          host: "127.0.0.1:3000",
          origin: authorityOrigin
        }, limited))
        expect(Result.isFailure(failed)).toBe(true)
      }
      const blocked = yield* Effect.result(authorizeBootstrapRequest({
        authorization: `Bearer ${bootstrapToken}`,
        host: "127.0.0.1:3000",
        origin: authorityOrigin
      }, limited))
      expect(Result.isFailure(blocked)).toBe(true)
      if (Result.isFailure(blocked)) {
        expect(blocked.failure.message).toBe("Bootstrap confirmation temporarily unavailable")
      }

      const atCap = yield* makeSecrets()
      yield* Ref.set(atCap.bootstrapAttemptState, { failedAttempts: 5, inFlight: 0 })
      const validAtCap = yield* Effect.result(authorizeBootstrapRequest({
        authorization: `Bearer ${bootstrapToken}`,
        host: "127.0.0.1:3000",
        origin: authorityOrigin
      }, atCap))
      expect(Result.isFailure(validAtCap)).toBe(true)
      expect(yield* Ref.get(atCap.bootstrapAvailable)).toBe(true)
    }))

  it.effect("atomically bounds concurrent invalid bootstrap attempts", () =>
    Effect.gen(function*() {
      const secrets = yield* makeSecrets()
      const results = yield* Effect.all(
        Array.from({ length: 6 }, () =>
          Effect.result(authorizeBootstrapRequest({
            authorization: "Bearer invalid",
            host: "127.0.0.1:3000",
            origin: authorityOrigin
          }, secrets))),
        { concurrency: "unbounded" }
      )
      const failures = results.filter(Result.isFailure)
      expect(failures).toHaveLength(6)
      expect(failures.filter((result) => result.failure.message === "Missing or invalid bootstrap token")).toHaveLength(
        5
      )
      expect(failures.filter((result) => result.failure.message === "Bootstrap confirmation temporarily unavailable"))
        .toHaveLength(1)
      expect((yield* Ref.get(secrets.bootstrapAttemptState)).failedAttempts).toBe(5)
    }))

  it.effect("starts bootstrap expiry only after server readiness", () =>
    Effect.gen(function*() {
      const delayed = yield* makeSecrets(false)
      yield* TestClock.adjust("61 seconds")
      const inactive = yield* Effect.result(authorizeBootstrapRequest({
        authorization: `Bearer ${bootstrapToken}`,
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000"
      }, delayed))
      expect(Result.isFailure(inactive)).toBe(true)

      yield* activateOwnerSessionBootstrap(delayed)
      yield* authorizeBootstrapRequest({
        authorization: `Bearer ${bootstrapToken}`,
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000"
      }, delayed)

      const expired = yield* makeSecrets(false)
      yield* activateOwnerSessionBootstrap(expired)
      yield* TestClock.adjust("61 seconds")
      const afterLifetime = yield* Effect.result(authorizeBootstrapRequest({
        authorization: `Bearer ${bootstrapToken}`,
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
        authorization: `Bearer ${bootstrapToken}`,
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000"
      }, justBeforeExpiry)

      const atExpiry = yield* makeSecrets(false)
      yield* activateOwnerSessionBootstrap(atExpiry)
      yield* TestClock.adjust(Duration.seconds(60))
      const result = yield* Effect.result(authorizeBootstrapRequest({
        authorization: `Bearer ${bootstrapToken}`,
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

  it.effect("only advertises the direct server or the supported Vite proxy origin", () =>
    Effect.gen(function*() {
      expect(yield* requireSupportedPublicOrigin("http://localhost:5173", authorityOrigin)).toBe(
        "http://localhost:5173"
      )
      expect(yield* requireSupportedPublicOrigin(authorityOrigin, authorityOrigin)).toBe(authorityOrigin)
      const unsupported = yield* Effect.result(
        requireSupportedPublicOrigin("http://localhost:4173", authorityOrigin)
      )
      expect(Result.isFailure(unsupported)).toBe(true)
      if (Result.isFailure(unsupported)) expect(unsupported.failure._tag).toBe("UnsafeServerHostnameError")
      expect(yield* resolveCodeCommitPublicOrigin("http://localhost:5173", 3001)).toBe("http://localhost:5173")
      expect(yield* resolveCodeCommitPublicOrigin(undefined, 3000)).toBe(authorityOrigin)
    }))

  it.effect("rejects unsupported configured origins before bootstrap URL emission", () =>
    Effect.gen(function*() {
      const secrets = yield* makeSecrets()
      const unsupported = yield* Effect.result(
        resolveCodeCommitBootstrapUrl("http://localhost:4173", 3000, secrets)
      )
      expect(Result.isFailure(unsupported)).toBe(true)
      if (Result.isFailure(unsupported)) expect(unsupported.failure._tag).toBe("UnsafeServerHostnameError")
      expect(yield* resolveCodeCommitBootstrapUrl("http://localhost:5173", 3000, secrets)).toContain(
        "#bootstrap_token="
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
