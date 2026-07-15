import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Fiber, Layer, Sink, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { streamEvents } from "../src/index.js"

const fakeProcessLayer = (
  calls: Array<ChildProcess.Command>,
  stdout: Stream.Stream<Uint8Array>,
  exitCode: Effect.Effect<ChildProcessSpawner.ExitCode> = Effect.succeed(ChildProcessSpawner.ExitCode(0)),
  options?: {
    readonly releases?: Array<"released">
    readonly stderr?: Stream.Stream<Uint8Array>
  }
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      calls.push(command)
      const handle = ChildProcessSpawner.makeHandle({
        all: stdout,
        exitCode,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        pid: ChildProcessSpawner.ProcessId(42),
        reref: Effect.void,
        stderr: options?.stderr ?? Stream.empty,
        stdin: Sink.drain,
        stdout,
        unref: Effect.succeed(Effect.void)
      })
      const acquire = Effect.succeed(handle)
      return options?.releases === undefined
        ? acquire
        : Effect.acquireRelease(
          acquire,
          () => Effect.sync(() => options.releases?.push("released"))
        )
    })
  )

const expectProviderPhase = (error: { readonly reason: unknown }, phase: "process" | "timeout") => {
  expect(error.reason).toMatchObject({
    _tag: "InternalProviderError",
    metadata: { "codex-cli": { phase } }
  })
}

describe("streamEvents", () => {
  it.effect("streams every validated raw event including native tool calls", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const threadStarted = "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}"
      const toolStarted = "{\"type\":\"item.started\",\"item\":{\"type\":\"command_execution\",\"command\":\"pwd\"}}"
      const toolCompleted =
        "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"status\":\"completed\"}}"
      const turnCompleted = "{\"type\":\"turn.completed\"}"
      const lines = [threadStarted, toolStarted, toolCompleted, turnCompleted]
      const releases: Array<"released"> = []
      const stdout = Stream.make(
        `${threadStarted}\n${toolStarted.slice(0, 35)}`,
        `${toolStarted.slice(35)}\n${toolCompleted}\n${turnCompleted}\n`
      ).pipe(Stream.encodeText)

      const events = yield* streamEvents({ cwd: "/workspace", prompt: "Run pwd" }).pipe(
        Stream.provide(fakeProcessLayer(calls, stdout, undefined, { releases })),
        Stream.runCollect
      )

      expect(Array.from(events)).toEqual(lines)
      expect(releases).toEqual(["released"])
      const command = calls[0]
      expect(command === undefined ? undefined : ChildProcess.isStandardCommand(command)).toBe(true)
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(command.args).toContain("--json")
        expect(command.args).toContain("--ephemeral")
        expect(command.args).toContain("read-only")
        expect(command.args).not.toContain("--cd")
        expect(command.options.cwd).toBe("/workspace")
      }
    }))

  it.effect("emits the first event without waiting for process completion", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const releases: Array<"released"> = []
      const stdout = Stream.make("{\"type\":\"turn.started\"}\n").pipe(
        Stream.encodeText,
        Stream.concat(Stream.never)
      )

      const events = yield* streamEvents({ cwd: "/workspace", prompt: "Start" }).pipe(
        Stream.provide(fakeProcessLayer(calls, stdout, Effect.never, { releases })),
        Stream.take(1),
        Stream.runCollect
      )

      expect(Array.from(events)).toEqual(["{\"type\":\"turn.started\"}"])
      expect(releases).toEqual(["released"])
    }))

  it.effect("uses the isolated environment for native event streams", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      yield* streamEvents({
        cwd: "/workspace",
        environment: { CUSTOM_PROVIDER_KEY: "custom-provider-key" },
        prompt: "Start"
      }).pipe(
        Stream.provide(fakeProcessLayer(
          calls,
          Stream.make("{\"type\":\"turn.completed\"}\n").pipe(Stream.encodeText)
        )),
        Stream.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
          env: {
            AWS_SECRET_ACCESS_KEY: "aws-secret-canary",
            CODEX_API_KEY: "codex-api-key",
            HOME: "/home/reviewer",
            PATH: "/reviewed/bin"
          }
        }))),
        Stream.runDrain
      )

      const command = calls[0]
      expect(command !== undefined && ChildProcess.isStandardCommand(command)).toBe(true)
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(command.options.extendEnv).toBe(false)
        expect(command.options.env).toEqual({
          CODEX_API_KEY: "codex-api-key",
          CUSTOM_PROVIDER_KEY: "custom-provider-key",
          HOME: "/home/reviewer",
          PATH: "/reviewed/bin"
        })
        expect(command.options.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY")
      }
    }))

  it.effect("accepts a multibyte prompt exactly at its UTF-8 byte limit", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const stdout = Stream.make("{\"type\":\"turn.completed\"}\n").pipe(Stream.encodeText)

      yield* streamEvents({ cwd: "/workspace", maxPromptBytes: 4, prompt: "éé" }).pipe(
        Stream.provide(fakeProcessLayer(calls, stdout)),
        Stream.runDrain
      )

      expect(calls).toHaveLength(1)
    }))

  it.effect("rejects an oversized multibyte prompt before spawning", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const exit = yield* streamEvents({ cwd: "/workspace", maxPromptBytes: 3, prompt: "éé" }).pipe(
        Stream.provide(fakeProcessLayer(calls, Stream.empty)),
        Stream.runDrain,
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toHaveLength(0)
    }))

  it.effect("rejects malformed JSONL through the typed error channel", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const exit = yield* streamEvents({ cwd: "/workspace", prompt: "Start" }).pipe(
        Stream.provide(fakeProcessLayer(calls, Stream.make("not-json\n").pipe(Stream.encodeText))),
        Stream.runDrain,
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("rejects valid JSON that is not a Codex event", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const exit = yield* streamEvents({ cwd: "/workspace", prompt: "Start" }).pipe(
        Stream.provide(fakeProcessLayer(calls, Stream.make("42\n").pipe(Stream.encodeText))),
        Stream.runDrain,
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("times out and releases a never-ending process", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const releases: Array<"released"> = []
      const fiber = yield* streamEvents({ cwd: "/workspace", prompt: "Wait", timeout: "1 second" }).pipe(
        Stream.provide(fakeProcessLayer(calls, Stream.never, Effect.never, {
          releases,
          stderr: Stream.never
        })),
        Stream.runDrain,
        Effect.forkChild({ startImmediately: true })
      )

      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)

      expect(calls).toHaveLength(1)
      expectProviderPhase(error, "timeout")
      expect(releases).toEqual(["released"])
    }))

  it.effect("fails and releases when stdout exceeds its bound", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const releases: Array<"released"> = []
      const error = yield* streamEvents({
        cwd: "/workspace",
        maxOutputBytes: 4,
        prompt: "Start"
      }).pipe(
        Stream.provide(fakeProcessLayer(
          calls,
          Stream.make("{\"type\":\"turn.started\"}\n").pipe(Stream.encodeText),
          undefined,
          { releases }
        )),
        Stream.runDrain,
        Effect.flip
      )

      expectProviderPhase(error, "process")
      expect(releases).toEqual(["released"])
    }))

  it.effect("fails and releases when stderr exceeds its bound", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const releases: Array<"released"> = []
      const error = yield* streamEvents({
        cwd: "/workspace",
        maxStderrBytes: 4,
        prompt: "Start"
      }).pipe(
        Stream.provide(fakeProcessLayer(calls, Stream.never, Effect.never, {
          releases,
          stderr: Stream.make("stderr overflow").pipe(Stream.encodeText)
        })),
        Stream.runDrain,
        Effect.flip
      )

      expectProviderPhase(error, "process")
      expect(releases).toEqual(["released"])
    }))

  it.effect("reports a non-zero exit after emitted events and releases", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const releases: Array<"released"> = []
      const error = yield* streamEvents({ cwd: "/workspace", prompt: "Start" }).pipe(
        Stream.provide(fakeProcessLayer(
          calls,
          Stream.make("{\"type\":\"turn.started\"}\n").pipe(Stream.encodeText),
          Effect.succeed(ChildProcessSpawner.ExitCode(9)),
          {
            releases,
            stderr: Stream.make("provider failed").pipe(Stream.encodeText)
          }
        )),
        Stream.runDrain,
        Effect.flip
      )

      expectProviderPhase(error, "process")
      expect(releases).toEqual(["released"])
    }))
})
