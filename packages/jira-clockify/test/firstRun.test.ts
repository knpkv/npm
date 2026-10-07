/** @effect-diagnostics strictEffectProvide:skip-file — each case builds its own synthetic world, so it is the entry point. */
/**
 * What a first-time user sees: Jira not connected, no terminal to answer a prompt, nothing set up.
 *
 * Each command runs through the real `root` over the synthetic world, whose Stdio is not a terminal.
 * A failure is the command's exit; the line the binary prints is that failure's message.
 */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Option, Stdio } from "effect"
import { Command } from "effect/cli"
import { HttpClient } from "effect/http"
import { root } from "../src/cli/root.js"
import { checkAuthOrSetup } from "../src/cli/setup.js"
import { ClockifyAuth } from "../src/services/ClockifyAuth.js"
import { JiraAccess } from "../src/services/JiraAccess.js"
import { makeFakeHeadless } from "../src/testing/fakeHeadless.js"
import { NOT_LOGGED_IN_HINT } from "../src/utils/hints.js"

/** Runs `jcf <args>` and returns the printed stdout and, when it failed, the line it fails with. */
const jcf = (args: ReadonlyArray<string>, options: { readonly jiraLoggedIn: boolean }) =>
  Effect.gen(function*() {
    const fake = makeFakeHeadless({ jiraLoggedIn: options.jiraLoggedIn })
    const exit = yield* Command.runWith(root, { version: "0.0.0-test" })(args).pipe(
      Effect.exit,
      Effect.provide(fake.layer)
    )
    return {
      stdout: fake.world.stdout,
      failure: Exit.isFailure(exit) ? Cause.prettyErrors(exit.cause)[0]?.message ?? "" : null
    }
  })

describe("Jira not connected", () => {
  // QA-J4: `issue list` printed "No tickets found" and exited 0.
  it.effect("issue list fails and names the command that connects Jira", () =>
    Effect.gen(function*() {
      const result = yield* jcf(["issue", "list"], { jiraLoggedIn: false })
      expect(result.failure).toBe(NOT_LOGGED_IN_HINT)
      expect(result.failure).toBe("Jira is not connected. Run jcf auth jira token to connect it.")
      expect(result.stdout.join("\n")).not.toContain("No ")
    }))

  // QA-J6: `timer start` said "No tickets found" and exited 0; with a key it printed and returned.
  it.effect("timer start fails the same way, with or without an issue key", () =>
    Effect.gen(function*() {
      expect((yield* jcf(["timer", "start"], { jiraLoggedIn: false })).failure).toBe(NOT_LOGGED_IN_HINT)
      expect((yield* jcf(["timer", "start", "PROJ-1"], { jiraLoggedIn: false })).failure).toBe(NOT_LOGGED_IN_HINT)
    }))

  // QA-J13: status said "not logged in" and nothing about what to run.
  it.effect("auth status names the next command for Jira, and how Jira is connected once it is", () =>
    Effect.gen(function*() {
      const out = yield* jcf(["auth", "status"], { jiraLoggedIn: false })
      expect(out.stdout[0]).toBe("Jira:     not connected. Run jcf auth jira token")
      const connected = yield* jcf(["auth", "status"], { jiraLoggedIn: true })
      expect(connected.stdout[0]).toMatch(/^Jira: {5}connected as Fake User on \S+ \(OAuth app\)$/u)
    }))
})

describe("no terminal to answer", () => {
  // QA-J7: `auth clockify setup` without a TTY printed "Error: " and exited 0.
  it.effect("Clockify setup fails and points at --api-key", () =>
    jcf(["auth", "clockify", "setup"], { jiraLoggedIn: true }).pipe(
      Effect.map((result) =>
        expect(result.failure).toBe(
          "This step needs an interactive terminal. Pass the key with --api-key, " +
            "or run jcf auth clockify setup in a terminal."
        )
      )
    ))

  it.effect("Jira token setup fails before asking, so the token is never read from a pipe", () =>
    jcf(["auth", "jira", "token"], { jiraLoggedIn: false }).pipe(
      Effect.map((result) => expect(result.failure).toContain("Run jcf auth jira token in a terminal"))
    ))

  // QA-J3: login before configure named a command that does not exist, and exited 0.
  it.effect("OAuth login without an app names both ways in", () =>
    Effect.gen(function*() {
      const result = yield* jcf(["auth", "jira", "login"], { jiraLoggedIn: false })
      expect(result.failure).toContain("Run jcf auth jira token to use an API token instead")
    }))

  // QA-J1: bare `jcf` with nothing set up printed raw prompt escapes, then "Setup incomplete", exit 0.
  it.effect("first run with nothing connected names both commands and fails", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(checkAuthOrSetup)
      expect(failure.message).toBe(
        "This step needs an interactive terminal. " +
          "Connect Jira with jcf auth jira token, or Clockify with jcf auth clockify setup."
      )
    }).pipe(
      Effect.provide(Layer.mergeAll(
        Layer.succeed(ClockifyAuth, {
          getConfig: Effect.die("unused"),
          save: () => Effect.die("unused"),
          isConfigured: Effect.succeed(false)
        }),
        Layer.succeed(JiraAccess, {
          connection: Effect.succeed(Option.none()),
          verifyToken: () => Effect.die("unused"),
          saveToken: () => Effect.die("unused"),
          removeToken: Effect.die("unused")
        }),
        Stdio.layerTest({}),
        Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die("unused"))),
        NodeServices.layer
      ))
    ))
})
