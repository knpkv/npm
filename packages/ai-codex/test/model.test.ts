import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, Schema, Sink, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { model } from "../src/index.js"

interface FakeProcessOptions {
  readonly exitCode?: number
  readonly stderr?: string
  readonly stdout: string
}

const fakeProcessLayer = (
  calls: Array<ChildProcess.Command>,
  options: FakeProcessOptions
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      calls.push(command)
      const stdout = Stream.make(options.stdout).pipe(Stream.encodeText)
      const stderr = Stream.make(options.stderr ?? "").pipe(Stream.encodeText)
      return Effect.succeed(ChildProcessSpawner.makeHandle({
        all: Stream.concat(stdout, stderr),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode ?? 0)),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        pid: ChildProcessSpawner.ProcessId(42),
        reref: Effect.void,
        stderr,
        stdin: Sink.drain,
        stdout,
        unref: Effect.succeed(Effect.void)
      }))
    })
  )

const successTranscript = (text: string): string =>
  [
    JSON.stringify({ thread_id: "thread-1", type: "thread.started" }),
    JSON.stringify({ item: { text, type: "agent_message" }, type: "item.completed" }),
    JSON.stringify({
      type: "turn.completed",
      usage: { cached_input_tokens: 2, input_tokens: 7, output_tokens: 3 }
    })
  ].join("\n")

const provideTestRuntime = <Result, Error, Requirements>(
  effect: Effect.Effect<Result, Error, Requirements>,
  calls: Array<ChildProcess.Command>,
  process: FakeProcessOptions
) =>
  effect.pipe(
    Effect.provide(model({ cwd: "/workspace" })),
    Effect.provide(fakeProcessLayer(calls, process)),
    Effect.provide(NodeFileSystem.layer)
  )

describe("model", () => {
  it.effect("generates text with safe bounded defaults", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const response = yield* provideTestRuntime(
        LanguageModel.generateText({ prompt: "Say hello" }),
        calls,
        { stdout: successTranscript("hello") }
      )

      expect(response.text).toBe("hello")
      expect(response.usage.inputTokens.total).toBe(7)
      expect(calls).toHaveLength(1)
      const command = calls[0]
      expect(command === undefined ? undefined : ChildProcess.isStandardCommand(command)).toBe(true)
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(command.command).toBe("codex")
        expect(command.args).toContain("--ephemeral")
        expect(command.args).not.toContain("--ignore-user-config")
        expect(command.args).toContain("read-only")
        expect(command.args).not.toContain("--cd")
        expect(command.options.cwd).toBe("/workspace")
        expect(command.options.detached).toBeUndefined()
        expect(command.options.shell).toBe(false)
      }
    }))

  it.effect("uses a scoped output schema for structured output", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const response = yield* provideTestRuntime(
        LanguageModel.generateObject({
          prompt: "Return status",
          schema: Schema.Struct({ status: Schema.String })
        }),
        calls,
        { stdout: successTranscript("{\"status\":\"ready\"}") }
      )

      expect(response.value).toEqual({ status: "ready" })
      const command = calls[0]
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(command.args).toContain("--output-schema")
      }
    }))

  it.effect("forwards only the reviewed Codex child environment", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      yield* LanguageModel.generateText({ prompt: "Say hello" }).pipe(
        Effect.provide(model({
          cwd: "/workspace",
          environment: { CUSTOM_PROVIDER_KEY: "custom-provider-key" }
        })),
        Effect.provide(fakeProcessLayer(calls, { stdout: successTranscript("hello") })),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
          env: {
            AWS_SECRET_ACCESS_KEY: "aws-secret-canary",
            CODEX_ACCESS_TOKEN: "codex-access-token",
            CODEX_API_KEY: "codex-api-key",
            CODEX_HOME: "/home/reviewer/.codex",
            CODEX_THREAD_ID: "session-canary",
            HOME: "/home/reviewer",
            PATH: "/reviewed/bin",
            SENTRY_AUTH_TOKEN: "vendor-canary",
            XDG_CONFIG_HOME: "/home/reviewer/.config"
          }
        })))
      )

      const command = calls[0]
      expect(command !== undefined && ChildProcess.isStandardCommand(command)).toBe(true)
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(command.options.extendEnv).toBe(false)
        expect(command.options.env).toEqual({
          CODEX_ACCESS_TOKEN: "codex-access-token",
          CODEX_API_KEY: "codex-api-key",
          CODEX_HOME: "/home/reviewer/.codex",
          CUSTOM_PROVIDER_KEY: "custom-provider-key",
          HOME: "/home/reviewer",
          PATH: "/reviewed/bin",
          XDG_CONFIG_HOME: "/home/reviewer/.config"
        })
        expect(command.options.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY")
        expect(command.options.env).not.toHaveProperty("CODEX_THREAD_ID")
        expect(command.options.env).not.toHaveProperty("SENTRY_AUTH_TOKEN")
      }
    }))

  it.effect("rejects file prompt parts before spawning Codex", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const exit = yield* provideTestRuntime(
        LanguageModel.generateText({
          prompt: [{
            content: [{ data: "aGVsbG8=", mediaType: "text/plain", type: "file" }],
            role: "user"
          }]
        }),
        calls,
        { stdout: successTranscript("unused") }
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toHaveLength(0)
    }))

  it.effect("fails with AiError when stdout exceeds its configured bound", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const exit = yield* LanguageModel.generateText({ prompt: "Say hello" }).pipe(
        Effect.provide(model({ cwd: "/workspace", maxOutputBytes: 8 })),
        Effect.provide(fakeProcessLayer(calls, { stdout: successTranscript("hello") })),
        Effect.provide(NodeFileSystem.layer),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("rejects an oversized rendered prompt before spawning", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const exit = yield* LanguageModel.generateText({ prompt: "éé" }).pipe(
        Effect.provide(model({ cwd: "/workspace", maxPromptBytes: 8 })),
        Effect.provide(fakeProcessLayer(calls, { stdout: successTranscript("unused") })),
        Effect.provide(NodeFileSystem.layer),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toHaveLength(0)
    }))
})
