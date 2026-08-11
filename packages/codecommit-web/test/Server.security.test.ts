import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted, Ref, Result } from "effect"
import { CodeCommitApi, OwnerSessionAuth } from "../src/server/Api.js"
import { encodeSandbox } from "../src/server/handlers/sandbox-live.js"
import {
  authorizeBootstrapRequest,
  authorizeOwnerRequest,
  type OwnerSessionSecretsShape,
  ownerSessionUrl,
  requireLoopbackHostname
} from "../src/server/internal/OwnerSessionSecurity.js"

const makeSecrets = Effect.fn("ServerSecurityTest.makeSecrets")(
  function*(): Effect.fn.Return<OwnerSessionSecretsShape> {
    return {
      ownerToken: Redacted.make("owner-secret"),
      csrfToken: Redacted.make("csrf-secret"),
      bootstrapToken: Redacted.make("bootstrap-secret"),
      bootstrapAvailable: yield* Ref.make(true),
      bootstrapExpiresAtMillis: Number.MAX_SAFE_INTEGER
    }
  }
)

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
    }))

  it.effect("allows loopback listeners and rejects peer-facing hostnames", () =>
    Effect.gen(function*() {
      expect(yield* requireLoopbackHostname("127.0.0.1")).toBe("127.0.0.1")
      const result = yield* Effect.result(requireLoopbackHostname("0.0.0.0"))
      expect(Result.isFailure(result)).toBe(true)
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
