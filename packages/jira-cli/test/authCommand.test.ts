/** @effect-diagnostics strictEffectProvide:skip-file */
/**
 * `jira auth create` must list every scope `jira auth login` requests: Atlassian rejects an
 * authorization request naming a scope the app lacks, so a shorter list is a setup that cannot log in.
 */
import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Command } from "effect/cli"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { FetchHttpClient } from "effect/http"
import * as Layer from "effect/Layer"
import { ChildProcessSpawner } from "effect/process"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { authCommand } from "../src/commands/auth.js"
import { jiraCliDescriptor, layer } from "../src/JiraAuth.js"

const browserOpens = ChildProcessSpawner.make(() =>
  Effect.succeed(ChildProcessSpawner.makeHandle({
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
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
)

it.effect("auth create lists every scope JiraAuth logs in with", () =>
  Effect.gen(function*() {
    const lines: Array<string> = []
    const capture: Console.Console = Object.assign(Object.create(console), {
      log: (...parts: ReadonlyArray<unknown>) => lines.push(parts.join(" "))
    })
    const cli = Command.runWith(Command.make("jira").pipe(Command.withSubcommands([authCommand])), { version: "0" })
    const exit = yield* cli(["auth", "create"]).pipe(Effect.provideService(Console.Console, capture), Effect.exit)
    expect(exit._tag).toBe("Success")
    const output = lines.join("\n")
    const permissions = jiraCliDescriptor.scopes.filter((scope) => scope !== "offline_access")
    expect(permissions.length).toBeGreaterThan(2)
    for (const scope of permissions) expect(output).toContain(scope)
    expect(output).toContain("jira auth configure")
  }).pipe(
    // The command's browser launch sees the fake; the auth layer is built over real platform services.
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, browserOpens),
    Effect.provide(layer.pipe(Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer))))
  ))
