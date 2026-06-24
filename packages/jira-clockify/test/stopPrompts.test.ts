/**
 * Unit tests for the shared stop/correction project + billable resolvers.
 *
 * These cover the non-interactive (pass-through / early-return) branches of
 * {@link resolveStopProject} and {@link resolveStopBillable}, which require no
 * Terminal. The prompting branches drive Effect CLI Prompts and are exercised
 * end-to-end via the interactive `stop` command rather than here.
 */
import { NodeServices, NodeTerminal } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { ClockifyApiClientShape } from "@knpkv/clockify-api-client"
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { resolveStopBillable, resolveStopProject } from "../src/cli/timer/stop.js"
import { ClockifyAuth } from "../src/services/ClockifyAuth.js"
import { ConfigService } from "../src/services/ConfigService.js"

const WORKSPACE_ID = "ws-1"

let savedPatches: Array<unknown> = []

const mockClockify: Partial<ClockifyApiClientShape> = {
  getProjects: () => Effect.succeed([])
}

const MockClockifyLayer = Layer.succeed(ClockifyApiClient, mockClockify as ClockifyApiClientShape)

const MockClockifyAuthLayer = Layer.succeed(ClockifyAuth, {
  getConfig: Effect.succeed({
    apiKey: Redacted.make("key"),
    workspaceId: WORKSPACE_ID,
    userId: "user-1",
    baseUrl: "https://api.clockify.me/api"
  }),
  save: () => Effect.void,
  isConfigured: Effect.succeed(true)
})

const MockConfigLayer = Layer.succeed(ConfigService, {
  get: Effect.succeed({
    defaultJql: "",
    refreshInterval: 30,
    projectMap: {},
    workspaceId: null,
    defaultProjectId: null,
    defaultProjectName: null,
    defaultBillable: true
  }),
  set: (patch) =>
    Effect.sync(() => {
      savedPatches.push(patch)
    }),
  configDir: Effect.succeed("/tmp/.jcf")
})

// NodeTerminal.layer satisfies the Terminal requirement the resolvers carry
// in their R channel for the (unexercised here) Effect CLI prompting branches.
// The non-interactive branches under test never touch it at runtime.
const TestLayer = Layer.mergeAll(
  MockClockifyLayer,
  MockClockifyAuthLayer,
  MockConfigLayer,
  NodeServices.layer,
  NodeTerminal.layer
)

describe("resolveStopProject (non-interactive branches)", () => {
  // Project already set on the running timer: pass the flag value straight
  // through with no prompt (and no config write).
  it.effect("returns the flag value untouched when a project is already set", () =>
    Effect.gen(function*() {
      savedPatches = []
      const result = yield* resolveStopProject({ currentProjectId: "proj-current", flagProjectId: "proj-flag" })
      expect(result).toBe("proj-flag")
      expect(savedPatches).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)))

  // A --project flag short-circuits the prompt even with no current project.
  it.effect("returns the flag value when only the flag is provided", () =>
    Effect.gen(function*() {
      savedPatches = []
      const result = yield* resolveStopProject({ currentProjectId: null, flagProjectId: "proj-flag" })
      expect(result).toBe("proj-flag")
      expect(savedPatches).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)))

  // Nothing set and Clockify lists no projects: leave it unset, no prompt.
  it.effect("returns undefined when no project is set and none are available", () =>
    Effect.gen(function*() {
      savedPatches = []
      const result = yield* resolveStopProject({ currentProjectId: null, flagProjectId: undefined })
      expect(result).toBeUndefined()
      expect(savedPatches).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)))
})

describe("resolveStopBillable (non-interactive branches)", () => {
  // Billable already set on the running timer: pass the flag through, no prompt.
  it.effect("returns the flag value untouched when billable is already set", () =>
    Effect.gen(function*() {
      savedPatches = []
      const result = yield* resolveStopBillable({ currentBillable: true, flagBillable: false })
      expect(result).toBe(false)
      expect(savedPatches).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)))

  // A --billable flag short-circuits the prompt even when current is unset.
  it.effect("returns the flag value when only the flag is provided", () =>
    Effect.gen(function*() {
      savedPatches = []
      const result = yield* resolveStopBillable({ currentBillable: null, flagBillable: true })
      expect(result).toBe(true)
      expect(savedPatches).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)))
})
