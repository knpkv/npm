/** @effect-diagnostics strictEffectProvide:skip-file */
/**
 * The shared `auth` command group: its setup text lists exactly the scopes the service logs in
 * with, a browser that never opens fails the command after the URL is printed, and the profile
 * commands read the same store for every product.
 */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Command } from "effect/cli"
import * as Console from "effect/Console"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import { ChildProcessSpawner } from "effect/process"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { type AuthCommandService, makeAuthCommand, scopeInstructions } from "../src/cli-auth/index.js"
import type { AuthProfile } from "../src/config/index.js"

class TestAuth extends Context.Service<TestAuth, AuthCommandService>()("test/TestAuth") {}

const SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "manage:jira-project",
  "read:jira-user",
  "read:me",
  "offline_access"
]

const descriptor = { commandName: "jira", productName: "Jira", scopes: SCOPES }

const profile: AuthProfile = {
  id: "cloud-1:account-1",
  name: "User 1 @ site-1",
  token: {
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_at: 0,
    scope: "read:me",
    cloud_id: "cloud-1",
    site_url: "https://site-1.atlassian.net",
    user: { account_id: "account-1", name: "User 1", email: "user-1@example.com" }
  },
  created_at: "2026-10-05T00:00:00.000Z",
  updated_at: "2026-10-05T00:00:00.000Z"
}

const fakeAuth = (active: AuthProfile | null): AuthCommandService => ({
  configure: () => Effect.void,
  login: () => Effect.void,
  logout: () => Effect.void,
  getActiveProfile: () => Effect.succeed(active),
  listProfiles: () => Effect.succeed(active === null ? [] : [active]),
  switchProfile: () => Effect.succeed(null),
  removeProfile: () => Effect.succeed(null)
})

// `opens` decides whether `open` exits 0; every other launcher is missing.
const launchers = (opens: boolean) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      command._tag === "StandardCommand" && command.command === "open"
        ? Effect.succeed(ChildProcessSpawner.makeHandle({
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(opens ? 0 : 1)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          pid: ChildProcessSpawner.ProcessId(1),
          reref: Effect.void,
          stderr: Stream.empty,
          stdin: Sink.drain,
          stdout: Stream.empty,
          unref: Effect.succeed(Effect.void)
        }))
        : Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }))
    )
  )

const run = (
  args: ReadonlyArray<string>,
  options: { readonly active?: AuthProfile | null; readonly opens?: boolean }
) =>
  Effect.gen(function*() {
    const lines: Array<string> = []
    const capture: Console.Console = Object.assign(Object.create(console), {
      log: (...parts: ReadonlyArray<unknown>) => lines.push(parts.join(" "))
    })
    const cli = Command.runWith(
      Command.make("jira").pipe(
        Command.withSubcommands([makeAuthCommand(TestAuth, descriptor, { apiSection: "Jira API" })])
      ),
      { version: "0.0.0-test" }
    )
    const exit = yield* cli(["auth", ...args]).pipe(
      Effect.provideService(Console.Console, capture),
      Effect.provide(Layer.mergeAll(
        NodeServices.layer,
        launchers(options.opens ?? true),
        Layer.succeed(TestAuth, fakeAuth(options.active ?? null))
      )),
      Effect.exit
    )
    return { exit, output: lines.join("\n") }
  })

describe("makeAuthCommand", () => {
  it("lists every login scope except offline_access, read:me under User Identity", () => {
    const text = scopeInstructions(descriptor, "Jira API")
    for (const scope of SCOPES.filter((scope) => scope !== "offline_access")) expect(text).toContain(scope)
    expect(text).not.toContain("offline_access")
    expect(text.indexOf("User Identity API")).toBeLessThan(text.indexOf("read:me"))
    expect(text.indexOf("Jira API")).toBeLessThan(text.indexOf("read:jira-work"))
  })

  it.effect("create prints the service's scopes and its own command name, then opens the console", () =>
    Effect.gen(function*() {
      const { exit, output } = yield* run(["create"], {})
      expect(exit._tag).toBe("Success")
      for (const scope of ["write:jira-work", "manage:jira-project"]) expect(output).toContain(scope)
      expect(output).toContain("jira auth configure --client-id")
      expect(output).toContain("Opening https://developer.atlassian.com/console/myapps/create-3lo-app/")
    }))

  it.effect("create and manage fail when no browser opens, after printing the URL", () =>
    Effect.gen(function*() {
      for (const subcommand of ["create", "manage"]) {
        const { exit, output } = yield* run([subcommand], { opens: false })
        expect(exit._tag, subcommand).toBe("Failure")
        expect(output, subcommand).toContain("Opening https://developer.atlassian.com/console/myapps/")
      }
    }))

  it.effect("status prints the active profile, or how to log in", () =>
    Effect.gen(function*() {
      const active = yield* run(["status"], { active: profile })
      expect(active.output).toContain("Active profile: User 1 @ site-1")
      expect(active.output).toContain("Account: User 1 (user-1@example.com)")
      expect(active.output).toContain("Site: https://site-1.atlassian.net")
      expect((yield* run(["status"], {})).output).toContain("Not logged in. Use 'jira auth login' to authenticate.")
    }))

  it.effect("profiles marks the active one; use and remove report an unknown selector", () =>
    Effect.gen(function*() {
      expect((yield* run(["profiles"], { active: profile })).output).toContain("* cloud-1:account-1")
      expect((yield* run(["use", "nope"], {})).output).toContain("Profile not found: nope")
      expect((yield* run(["remove", "nope"], {})).output).toContain("Profile not found: nope")
    }))
})
