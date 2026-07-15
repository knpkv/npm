import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Sink, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { streamEvents } from "../src/index.js"

const fakeProcessLayer = (
  calls: Array<ChildProcess.Command>,
  stdout: Stream.Stream<Uint8Array>,
  exitCode: Effect.Effect<ChildProcessSpawner.ExitCode> = Effect.succeed(ChildProcessSpawner.ExitCode(0))
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      calls.push(command)
      return Effect.succeed(ChildProcessSpawner.makeHandle({
        all: stdout,
        exitCode,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        pid: ChildProcessSpawner.ProcessId(42),
        reref: Effect.void,
        stderr: Stream.empty,
        stdin: Sink.drain,
        stdout,
        unref: Effect.succeed(Effect.void)
      }))
    })
  )

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
      const stdout = Stream.make(
        `${threadStarted}\n${toolStarted.slice(0, 35)}`,
        `${toolStarted.slice(35)}\n${toolCompleted}\n${turnCompleted}\n`
      ).pipe(Stream.encodeText)

      const events = yield* streamEvents({ cwd: "/workspace", prompt: "Run pwd" }).pipe(
        Stream.provide(fakeProcessLayer(calls, stdout)),
        Stream.runCollect
      )

      expect(Array.from(events)).toEqual(lines)
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
      const stdout = Stream.make("{\"type\":\"turn.started\"}\n").pipe(
        Stream.encodeText,
        Stream.concat(Stream.never)
      )

      const events = yield* streamEvents({ cwd: "/workspace", prompt: "Start" }).pipe(
        Stream.provide(fakeProcessLayer(calls, stdout, Effect.never)),
        Stream.take(1),
        Stream.runCollect
      )

      expect(Array.from(events)).toEqual(["{\"type\":\"turn.started\"}"])
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
})
