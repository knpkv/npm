import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { make as makeClockifyApi } from "@knpkv/clockify-api-client"
import type { Schema } from "effect"
import { Effect, Layer, Option, Redacted, Result, Stdio } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { connectClockify, loadClockifyAccount } from "../src/cli/auth.js"
import { ClockifyAuth } from "../src/services/ClockifyAuth.js"
import workspaces from "./fixtures/clockify-workspaces.json" with { type: "json" }

const user = { id: "64f0c0ffee0000000000bb01", name: "Example User", email: "user@example.invalid" }

/** Clockify answered at the HTTP boundary: `/v1/user`, and `/v1/workspaces` with the given body and status. */
const clockifyClient = (workspacesBody: Schema.Json, userStatus = 200, workspacesStatus = 200) =>
  HttpClient.make((request) => {
    const respond = (body: Schema.Json, status: number) =>
      Effect.succeed(HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
      ))
    return request.url.endsWith("/v1/user")
      ? respond(userStatus === 200 ? user : { message: "Api key does not exist", code: 4003 }, userStatus)
      : respond(workspacesBody, workspacesStatus)
  })

const clockify = (workspacesBody: Schema.Json, userStatus = 200, workspacesStatus = 200) =>
  makeClockifyApi(clockifyClient(workspacesBody, userStatus, workspacesStatus), {
    apiKey: Redacted.make("test-key"),
    baseUrl: "https://api.clockify.me/api"
  })

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

  it.effect("reports an invalid key when Clockify rejects it at the workspaces request too", () =>
    Effect.gen(function*() {
      const result = yield* Effect.result(loadClockifyAccount(clockify({ message: "Unauthorized" }, 200, 403)))
      expect(Result.isFailure(result) && result.failure._tag).toBe("InvalidClockifyApiKeyError")
    }))
})

/** `auth clockify setup --api-key …` in a script: no terminal, Clockify answering with `workspacesBody`. */
const setupWithoutTerminal = (workspacesBody: Schema.Json, workspace?: string) => {
  const saved: Array<{ readonly workspaceId: string }> = []
  return Effect.gen(function*() {
    const world = yield* Layer.build(Layer.mergeAll(
      Layer.succeed(ClockifyAuth, {
        getConfig: Effect.die("unused"),
        save: (auth) => Effect.sync(() => void saved.push(auth)),
        isConfigured: Effect.succeed(false)
      }),
      Layer.succeed(HttpClient.HttpClient, clockifyClient(workspacesBody)),
      Stdio.layerTest({}),
      NodeServices.layer
    ))
    const result = yield* connectClockify(Option.some("test-key"), Option.fromUndefinedOr(workspace)).pipe(
      Effect.result,
      Effect.provideContext(world)
    )
    return { result, saved }
  })
}

const twoWorkspaces = [...workspaces, { ...workspaces[0], id: "64f0c0ffee0000000000aa02", name: "Second Workspace" }]

describe("connectClockify without a terminal", () => {
  // Review finding: --api-key is the scripting path, but two workspaces still reached a prompt.
  it.effect("asks for --workspace by name instead of prompting when the key has several", () =>
    Effect.gen(function*() {
      const { result, saved } = yield* setupWithoutTerminal(twoWorkspaces)
      expect(Result.isFailure(result) && result.failure.message).toBe(
        "This step needs an interactive terminal. This key can use 2 workspaces; pass --workspace with one of: " +
          "Example Workspace, Second Workspace."
      )
      expect(saved).toEqual([])
    }))

  it.effect("saves the named workspace, or the only one, without asking", () =>
    Effect.gen(function*() {
      const named = yield* setupWithoutTerminal(twoWorkspaces, "Second Workspace")
      expect(named.saved.map((auth) => auth.workspaceId)).toEqual(["64f0c0ffee0000000000aa02"])
      const only = yield* setupWithoutTerminal(workspaces)
      expect(only.saved.map((auth) => auth.workspaceId)).toEqual(["64f0c0ffee0000000000aa01"])
      const unknown = yield* setupWithoutTerminal(twoWorkspaces, "Nope")
      expect(Result.isFailure(unknown.result) && unknown.result.failure.message).toBe(
        "No workspace named \"Nope\" for this key. Its workspaces: Example Workspace, Second Workspace."
      )
    }))
})
