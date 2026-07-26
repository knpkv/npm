import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Result, Sink, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { readLocalCliRuntimeMetadata } from "../src/index.js"

const fakeProcessLayer = (
  calls: Array<ChildProcess.Command>,
  options: {
    readonly exitCode?: number
    readonly output: string
  }
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      calls.push(command)
      const output = Stream.make(options.output).pipe(Stream.encodeText)
      return Effect.succeed(ChildProcessSpawner.makeHandle({
        all: output,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode ?? 0)),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        pid: ChildProcessSpawner.ProcessId(42),
        reref: Effect.void,
        stderr: Stream.empty,
        stdin: Sink.drain,
        stdout: output,
        unref: Effect.succeed(Effect.void)
      }))
    })
  )

describe("local CLI runtime metadata", () => {
  it.effect("captures one bounded version without inheriting the parent environment", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const metadata = yield* readLocalCliRuntimeMetadata({
        executable: "/trusted/bin/codex",
        implementation: "codex-cli"
      }).pipe(
        Effect.provide(fakeProcessLayer(calls, { output: "codex-cli 1.2.3\nignored\n" })),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
          env: {
            AWS_SECRET_ACCESS_KEY: "must-not-be-forwarded",
            PATH: "/trusted/bin"
          }
        })))
      )

      expect(metadata).toEqual({
        _tag: "local-cli",
        implementation: "codex-cli",
        version: "1.2.3"
      })
      const command = calls[0]
      expect(command !== undefined && ChildProcess.isStandardCommand(command)).toBe(true)
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(command.command).toBe("/trusted/bin/codex")
        expect(command.args).toEqual(["--version"])
        expect(command.options.extendEnv).toBe(false)
        expect(command.options.env).toEqual({ PATH: "/trusted/bin" })
      }
    }))

  it.effect("fails closed when the CLI exits unsuccessfully", () =>
    Effect.gen(function*() {
      const result = yield* readLocalCliRuntimeMetadata({
        executable: "codex",
        implementation: "codex-cli"
      }).pipe(
        Effect.provide(fakeProcessLayer([], {
          exitCode: 1,
          output: "credential-canary"
        })),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
          env: { PATH: "/trusted/bin" }
        }))),
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
