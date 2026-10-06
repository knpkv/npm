import { describe, expect, it } from "@effect/vitest"
import { make as makeClockifyApi } from "@knpkv/clockify-api-client"
import type { Schema } from "effect"
import { Effect, Redacted, Result } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { loadClockifyAccount } from "../src/cli/auth.js"
import workspaces from "./fixtures/clockify-workspaces.json" with { type: "json" }

const user = { id: "64f0c0ffee0000000000bb01", name: "Example User", email: "user@example.invalid" }

/** Clockify answered at the HTTP boundary: `/v1/user`, and `/v1/workspaces` with the given body and status. */
const clockify = (workspacesBody: Schema.Json, userStatus = 200) =>
  makeClockifyApi(
    HttpClient.make((request) => {
      const respond = (body: Schema.Json, status: number) =>
        Effect.succeed(HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
        ))
      return request.url.endsWith("/v1/user")
        ? respond(userStatus === 200 ? user : { message: "Api key does not exist", code: 4003 }, userStatus)
        : respond(workspacesBody, 200)
    }),
    { apiKey: Redacted.make("test-key"), baseUrl: "https://api.clockify.me/api" }
  )

describe("loadClockifyAccount", () => {
  it.effect("decodes a real-shaped workspaces response, including its string subscription plan", () =>
    Effect.gen(function*() {
      const account = yield* loadClockifyAccount(clockify(workspaces))
      expect(account.workspaces).toEqual([{ id: "64f0c0ffee0000000000aa01", name: "Example Workspace" }])
    }))

  it.effect("fails with a typed error naming the operation when workspaces cannot be decoded", () =>
    Effect.gen(function*() {
      const result = yield* Effect.result(loadClockifyAccount(clockify([{ name: "missing id" }])))
      expect(Result.isFailure(result) && result.failure._tag).toBe("ClockifyRequestError")
      expect(Result.isFailure(result) && result.failure.message).toMatch(/^Clockify getWorkspacesOfUser failed: /)
    }))

  it.effect("reports an invalid key only when Clockify rejects it", () =>
    Effect.gen(function*() {
      const result = yield* Effect.result(loadClockifyAccount(clockify(workspaces, 401)))
      expect(Result.isFailure(result) && result.failure._tag).toBe("InvalidClockifyApiKeyError")
    }))
})
