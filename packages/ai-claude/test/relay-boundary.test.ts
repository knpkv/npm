/** @effect-diagnostics strictEffectProvide:skip-file */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema, Sink, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { model } from "../src/index.js"

const fakeProcessLayer = (calls: Array<ChildProcess.Command>, stdout: string) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      calls.push(command)
      const output = Stream.make(stdout).pipe(Stream.encodeText)
      return Effect.succeed(ChildProcessSpawner.makeHandle({
        all: output,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
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

const success = (structuredOutput: Schema.Json): string =>
  JSON.stringify({
    is_error: false,
    structured_output: structuredOutput,
    subtype: "success",
    type: "result"
  })

describe("Claude Relay adapter boundary", () => {
  it.effect("normalizes constrained native schemas", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const runtime = Layer.provide(
        model({ cwd: "/workspace" }),
        fakeProcessLayer(calls, success({ names: ["one"] }))
      )
      yield* LanguageModel.generateObject({
        prompt: "List names",
        schema: Schema.Struct({ names: Schema.Array(Schema.String).check(Schema.isUnique()) })
      }).pipe(Effect.provide(runtime))
      const command = calls[0]
      expect(command !== undefined && ChildProcess.isStandardCommand(command)).toBe(true)
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        const schemaIndex = command.args.indexOf("--json-schema")
        const schema = command.args[schemaIndex + 1] ?? ""
        expect(schema).not.toContain("allOf")
        expect(schema).not.toContain("uniqueItems")
      }
    }))

  it.effect("isolates prompt-only execution from settings and MCP", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const runtime = Layer.provide(
        model({ cwd: "/workspace", access: "prompt-only" }),
        fakeProcessLayer(calls, success("ok"))
      )
      yield* LanguageModel.generateText({ prompt: "Review this patch" }).pipe(Effect.provide(runtime))
      const command = calls[0]
      expect(command !== undefined && ChildProcess.isStandardCommand(command)).toBe(true)
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        const settingIndex = command.args.indexOf("--setting-sources")
        const mcpIndex = command.args.indexOf("--mcp-config")
        expect(command.args[settingIndex + 1]).toBe("")
        expect(command.args).toContain("--strict-mcp-config")
        expect(command.args[mcpIndex + 1]).toBe("{\"mcpServers\":{}}")
        const disallowedIndex = command.args.indexOf("--disallowed-tools")
        expect(command.args[disallowedIndex + 1]).toContain("mcp__*")
      }
    }))
})
