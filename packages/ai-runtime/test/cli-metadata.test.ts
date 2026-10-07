import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Result, Sink, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"

import { readLocalCliRuntimeMetadata } from "../src/index.js"

const fakeSpawner = (
  calls: Array<ChildProcess.Command>,
  options: {
    readonly all?: string
    readonly exitCode?: number
    readonly output: string
    readonly stderr?: string
  }
) =>
  ChildProcessSpawner.make((command) => {
    calls.push(command)
    const stdout = Stream.make(options.output).pipe(Stream.encodeText)
    const stderr = Stream.make(options.stderr ?? "").pipe(Stream.encodeText)
    const all = Stream.make(options.all ?? `${options.output}${options.stderr ?? ""}`).pipe(Stream.encodeText)
    return Effect.succeed(ChildProcessSpawner.makeHandle({
      all,
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode ?? 0)),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      pid: ChildProcessSpawner.ProcessId(42),
      stderr,
      stdin: Sink.drain,
      stdout,
      unref: Effect.succeed(Effect.void)
    }))
  })

/** Run `effect` against the fake CLI, with `env` as the only environment it can read. */
const withFakeCli = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  env: Record<string, string>
) =>
<A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
  effect.pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }))
  )

describe("local CLI runtime metadata", () => {
  it.effect("captures one bounded version without inheriting the parent environment", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const metadata = yield* readLocalCliRuntimeMetadata({
        cwd: "/trusted/workspace",
        executable: "./bin/codex",
        implementation: "codex-cli"
      }).pipe(
        withFakeCli(
          fakeSpawner(calls, {
            all: "credential-canary\ncodex-cli 1.2.3\nignored\n",
            output: "codex-cli 1.2.3\nignored\n",
            stderr: "credential-canary\n"
          }),
          {
            AWS_SECRET_ACCESS_KEY: "must-not-be-forwarded",
            PATH: "/trusted/bin"
          }
        )
      )

      expect(metadata).toEqual({
        _tag: "local-cli",
        implementation: "codex-cli",
        version: "1.2.3"
      })
      const command = calls[0]
      expect(command !== undefined && ChildProcess.isStandardCommand(command)).toBe(true)
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(command.command).toBe("./bin/codex")
        expect(command.args).toEqual(["--version"])
        expect(command.options.cwd).toBe("/trusted/workspace")
        expect(command.options.extendEnv).toBe(false)
        expect(command.options.env).toEqual({ PATH: "/trusted/bin" })
      }
    }))

  it.effect("preserves invalid-output when successful output exceeds the byte bound", () =>
    Effect.gen(function*() {
      const result = yield* readLocalCliRuntimeMetadata({
        executable: "codex",
        implementation: "codex-cli"
      }).pipe(
        withFakeCli(fakeSpawner([], { output: "x".repeat(4_097) }), { PATH: "/trusted/bin" }),
        Effect.result
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure.reason).toBe("invalid-output")
      }
    }))

  it.effect("rejects malformed and display-spoofing successful output", () =>
    Effect.gen(function*() {
      for (const output of ["", "1.2\u202e3"]) {
        const result = yield* readLocalCliRuntimeMetadata({
          executable: "codex",
          implementation: "codex-cli"
        }).pipe(
          withFakeCli(fakeSpawner([], { output }), { PATH: "/trusted/bin" }),
          Effect.result
        )

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure.reason).toBe("invalid-output")
        }
      }
    }))

  it.effect("fails closed when the CLI exits unsuccessfully", () =>
    Effect.gen(function*() {
      const result = yield* readLocalCliRuntimeMetadata({
        executable: "codex",
        implementation: "codex-cli"
      }).pipe(
        withFakeCli(
          fakeSpawner([], {
            exitCode: 1,
            output: "credential-canary"
          }),
          { PATH: "/trusted/bin" }
        ),
        Effect.result
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("AgentRuntimeMetadataError")
        expect(result.failure.implementation).toBe("codex-cli")
        expect(result.failure.reason).toBe("unavailable")
        expect(JSON.stringify(result.failure)).not.toContain("credential-canary")
      }
    }))
})
