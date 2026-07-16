import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, Schema, Sink, Stream } from "effect"
import { PlatformError, SystemError } from "effect/PlatformError"
import { LanguageModel } from "effect/unstable/ai"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { model } from "../src/index.js"

type FakeProcessOptions = {
  readonly exitCode?: number
  readonly spawnFailure?: PlatformError
  readonly stderr?: string
  readonly stdout: string
}

const fakeProcessLayer = (calls: Array<ChildProcess.Command>, options: FakeProcessOptions) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      calls.push(command)
      if (options.spawnFailure !== undefined) return Effect.fail(options.spawnFailure)
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

const success = (result: string): string =>
  JSON.stringify({
    is_error: false,
    result,
    subtype: "success",
    type: "result",
    usage: { input_tokens: 7, output_tokens: 3 }
  })

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>, calls: Array<ChildProcess.Command>, stdout: string) =>
  effect.pipe(
    Effect.provide(model({ cwd: "/workspace" })),
    Effect.provide(fakeProcessLayer(calls, { stdout }))
  )

describe("model", () => {
  it.effect("generates text with safe defaults", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const response = yield* provide(LanguageModel.generateText({ prompt: "Say hello" }), calls, success("hello"))
      expect(response.text).toBe("hello")
      const command = calls[0]
      expect(command !== undefined && ChildProcess.isStandardCommand(command)).toBe(true)
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(command.args).toContain("plan")
        expect(command.options.detached).toBeUndefined()
        expect(command.options.shell).toBe(false)
      }
    }))

  it.effect("forwards only the reviewed Claude child environment", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      yield* LanguageModel.generateText({ prompt: "Say hello" }).pipe(
        Effect.provide(model({ cwd: "/workspace" })),
        Effect.provide(fakeProcessLayer(calls, { stdout: success("hello") })),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
          env: {
            ANTHROPIC_API_KEY: "anthropic-api-key",
            ANTHROPIC_AUTH_TOKEN: "anthropic-auth-token",
            ANTHROPIC_BASE_URL: "https://anthropic.example.test",
            AWS_SECRET_ACCESS_KEY: "aws-secret-canary",
            CLAUDE_CONFIG_DIR: "/home/reviewer/.config/claude",
            CODEX_THREAD_ID: "session-canary",
            HOME: "/home/reviewer",
            PATH: "/reviewed/bin",
            SENTRY_AUTH_TOKEN: "vendor-canary",
            USERPROFILE: "C:\\Users\\reviewer",
            XDG_CONFIG_HOME: "/home/reviewer/.config"
          }
        })))
      )

      const command = calls[0]
      expect(command !== undefined && ChildProcess.isStandardCommand(command)).toBe(true)
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(Object.isFrozen(command)).toBe(true)
        expect(Object.isFrozen(command.args)).toBe(true)
        expect(Object.isFrozen(command.options)).toBe(true)
        expect(command.options.extendEnv).toBe(false)
        expect(command.options.env).toEqual({
          ANTHROPIC_API_KEY: "anthropic-api-key",
          ANTHROPIC_AUTH_TOKEN: "anthropic-auth-token",
          ANTHROPIC_BASE_URL: "https://anthropic.example.test",
          CLAUDE_CONFIG_DIR: "/home/reviewer/.config/claude",
          HOME: "/home/reviewer",
          PATH: "/reviewed/bin",
          USERPROFILE: "C:\\Users\\reviewer",
          XDG_CONFIG_HOME: "/home/reviewer/.config"
        })
        expect(command.options.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY")
        expect(command.options.env).not.toHaveProperty("CODEX_THREAD_ID")
        expect(command.options.env).not.toHaveProperty("SENTRY_AUTH_TOKEN")
        const environment = command.options.env
        const originalArguments = [...command.args]
        const stdin = command.options.stdin
        expect(environment === undefined ? false : Object.isFrozen(environment)).toBe(true)
        expect(() => Object.assign(command, { options: { extendEnv: true } })).toThrow()
        expect(() => Object.assign(command.args, { 0: "--dangerously-skip-permissions" })).toThrow()
        expect(() => Object.assign(command.options, { extendEnv: true })).toThrow()
        expect(() => Object.assign(environment ?? {}, { AWS_SECRET_ACCESS_KEY: "injected" })).toThrow()
        expect(typeof stdin === "object" && stdin !== null && Object.isFrozen(stdin)).toBe(true)
        if (typeof stdin === "object" && stdin !== null && "endOnDone" in stdin) {
          expect(stdin.endOnDone).toBe(true)
          expect(() => Object.assign(stdin, { endOnDone: false })).toThrow()
          expect(stdin.endOnDone).toBe(true)
        }
        expect(command.args).toEqual(originalArguments)
        expect(command.options.extendEnv).toBe(false)
        expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY")
      }
    }))

  it.effect("supports structured output", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const stdout = JSON.stringify({
        is_error: false,
        structured_output: { status: "ready" },
        subtype: "success",
        type: "result"
      })
      const response = yield* provide(
        LanguageModel.generateObject({ prompt: "Status", schema: Schema.Struct({ status: Schema.String }) }),
        calls,
        stdout
      )
      expect(response.value).toEqual({ status: "ready" })
      const command = calls[0]
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        const schemaIndex = command.args.indexOf("--json-schema")
        const schema = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
          command.args[schemaIndex + 1] ?? "null"
        )
        expect(schema).toMatchObject({
          properties: { status: { type: "string" } },
          required: ["status"],
          type: "object"
        })
        expect(schema).not.toHaveProperty("dialect")
        expect(schema).not.toHaveProperty("schema")
      }
    }))

  it.effect("rejects file prompts before spawning", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const exit = yield* provide(
        LanguageModel.generateText({
          prompt: [{ content: [{ data: "aGVsbG8=", mediaType: "text/plain", type: "file" }], role: "user" }]
        }),
        calls,
        success("unused")
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toHaveLength(0)
    }))

  it.effect("preserves assistant reasoning in conversation history", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      yield* provide(
        LanguageModel.generateText({
          prompt: [
            { content: [{ text: "Checked the release constraints", type: "reasoning" }], role: "assistant" },
            { content: [{ text: "Continue the review", type: "text" }], role: "user" }
          ]
        }),
        calls,
        success("done")
      )

      const command = calls[0]
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        const stdin = command.options.stdin
        if (typeof stdin === "object" && stdin !== null && "stream" in stdin && Stream.isStream(stdin.stream)) {
          const prompt = yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString)
          expect(prompt).toContain("Checked the release constraints")
          expect(prompt).toContain("Continue the review")
        }
      }
    }))

  it.effect("enforces the stdout bound", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const exit = yield* LanguageModel.generateText({ prompt: "hello" }).pipe(
        Effect.provide(model({ cwd: "/workspace", maxOutputBytes: 8 })),
        Effect.provide(fakeProcessLayer(calls, { stdout: success("hello") })),
        Effect.exit
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("rejects invalid process bounds before spawning", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const exit = yield* LanguageModel.generateText({ prompt: "hello" }).pipe(
        Effect.provide(model({ cwd: "/workspace", maxStderrBytes: 0 })),
        Effect.provide(fakeProcessLayer(calls, { stdout: success("unused") })),
        Effect.exit
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toHaveLength(0)
    }))

  it.effect("preserves usage in buffered streams", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const parts = yield* provide(
        LanguageModel.streamText({ prompt: "Say hello" }).pipe(Stream.runCollect),
        calls,
        success("hello")
      )
      const finish = Array.from(parts).find((part) => part.type === "finish")
      const textDeltas = Array.from(parts).filter((part) => part.type === "text-delta")
      expect(textDeltas).toEqual([expect.objectContaining({ delta: "hello" })])
      expect(finish?.usage.inputTokens.total).toBe(7)
      expect(finish?.usage.outputTokens.total).toBe(3)
      const command = calls[0]
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(command.args).toContain("json")
        expect(command.args).not.toContain("stream-json")
      }
    }))

  it.effect("classifies transport causes separately from malformed provider output", () =>
    Effect.gen(function*() {
      const spawnFailure = new PlatformError(
        new SystemError({
          _tag: "PermissionDenied",
          description: "fixture",
          method: "spawn",
          module: "ChildProcess"
        })
      )
      const transportError = yield* LanguageModel.generateText({ prompt: "hello" }).pipe(
        Effect.provide(model({ cwd: "/workspace" })),
        Effect.provide(fakeProcessLayer([], { spawnFailure, stdout: "" })),
        Effect.flip
      )
      expect(transportError.reason).toMatchObject({
        _tag: "InternalProviderError",
        metadata: { "claude-cli": { cause: "PlatformError", phase: "process" } }
      })

      const malformedError = yield* LanguageModel.generateText({ prompt: "hello" }).pipe(
        Effect.provide(model({ cwd: "/workspace" })),
        Effect.provide(fakeProcessLayer([], { stdout: "not-json" })),
        Effect.flip
      )
      expect(malformedError.reason).toMatchObject({ _tag: "InvalidOutputError" })
    }))
})
