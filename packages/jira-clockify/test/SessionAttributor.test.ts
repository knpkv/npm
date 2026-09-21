import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Predicate, Ref, Sink, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { defaultSessionAgentSettings, type SessionAgentSettings } from "../src/agent/agentSettings.js"
import { ConfigService, defaultJcfConfig } from "../src/services/ConfigService.js"
import { HomeDirectory } from "../src/services/HomeDirectory.js"
import { layer as SessionAttributorLayer, SessionAttributor } from "../src/services/SessionAttributor.js"

// Tests compose one isolated runtime per case, with every provider process replaced below.
// @effect-diagnostics strictEffectProvide:off
// @effect-diagnostics multipleEffectProvide:off

const request = [{ sessionId: "session-1", candidateKeys: ["PROJ-42"], digest: "Fixed PROJ-42 validation" }]
const describeRequest = [{ id: "item-1", ticketKey: "PROJ-42", summary: null, digest: "Fixed validation" }]
const answer = {
  answers: [{ sessionId: "session-1", ticketKey: "PROJ-42", confidence: 0.9, reason: "Worked on validation" }],
  notes: [{ id: "item-1", note: "Fixed validation" }]
}

const fakeSpawner = (calls: Array<ChildProcess.StandardCommand>, inventory: string) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(Effect.fn(function*(command) {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected piped provider command")
      calls.push(command)
      const output = command.args.join(" ") === "features list"
        ? inventory
        : command.command === "claude"
        ? JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: answer })
        : [
          JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(answer) } }),
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })
        ].join("\n")
      const stdout = Stream.make(`${output}\n`).pipe(Stream.encodeText)
      return ChildProcessSpawner.makeHandle({
        all: stdout,
        stdout,
        stderr: Stream.empty,
        stdin: Sink.drain,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        pid: ChildProcessSpawner.ProcessId(42),
        unref: Effect.succeed(Effect.void)
      })
    }))
  )

const testRuntime = (
  settings: Ref.Ref<SessionAgentSettings>,
  calls: Array<ChildProcess.StandardCommand>,
  inventory = "shell_tool stable true\nplugins stable true"
) =>
  SessionAttributorLayer.pipe(
    Layer.provide(Layer.succeed(ConfigService, {
      get: Ref.get(settings).pipe(Effect.map((sessionAgent) => ({ ...defaultJcfConfig, sessionAgent }))),
      set: () => Effect.die("Provider operations must never write config"),
      configDir: Effect.succeed("/fake-home/.jcf")
    })),
    Layer.provide(Layer.succeed(HomeDirectory, { path: "/fake-home" })),
    Layer.provide(fakeSpawner(calls, inventory)),
    Layer.provide(NodeFileSystem.layer)
  )

describe("SessionAttributor provider selection", () => {
  it.effect("describes unkeyed work without inventing an issue", () =>
    Effect.gen(function*() {
      const settings = yield* Ref.make(defaultSessionAgentSettings)
      const calls: Array<ChildProcess.StandardCommand> = []
      yield* Effect.gen(function*() {
        const attributor = yield* SessionAttributor
        yield* attributor.describe([{ id: "item-1", ticketKey: null, summary: null, digest: "Fixed validation" }])
      }).pipe(Effect.provide(testRuntime(settings, calls)))
      expect(calls).toHaveLength(1)
      const input = calls[0]?.options.stdin
      if (input === undefined || Predicate.isString(input) || !("stream" in input) || !Stream.isStream(input.stream)) {
        return yield* Effect.die("Expected a prompt on stdin")
      }
      const prompt = yield* input.stream.pipe(Stream.decodeText(), Stream.mkString)
      expect(prompt).toContain("No associated Jira issue")
      expect(prompt).not.toContain("Issue: null")
    }))

  it.effect("preserves Claude defaults when model and effort are unset", () =>
    Effect.gen(function*() {
      const settings = yield* Ref.make(defaultSessionAgentSettings)
      const calls: Array<ChildProcess.StandardCommand> = []
      yield* Effect.gen(function*() {
        const attributor = yield* SessionAttributor
        yield* attributor.attribute(request)
        yield* attributor.describe(describeRequest)
      }).pipe(Effect.provide(testRuntime(settings, calls)))
      expect(calls).toHaveLength(2)
      for (const command of calls) {
        expect(command.command).toBe("claude")
        expect(command.args).not.toContain("--model")
        expect(command.args).not.toContain("--effort")
        expect(command.args[command.args.indexOf("--tools") + 1]).toBe("")
        expect(command.args).toContain("dontAsk")
        expect(command.options.extendEnv).toBe(false)
      }
    }))

  it.effect("reads changed provider, model and effort on both operations without rebuilding the layer", () =>
    Effect.gen(function*() {
      const settings = yield* Ref.make<SessionAgentSettings>({
        provider: "claude",
        model: "claude-chosen",
        effort: "max"
      })
      const calls: Array<ChildProcess.StandardCommand> = []
      const activity = yield* Ref.make<ReadonlyArray<string>>([])
      yield* Effect.gen(function*() {
        const attributor = yield* SessionAttributor
        for (
          const sessionAgent of [
            { provider: "claude", model: "claude-chosen", effort: "max" },
            { provider: "codex", model: "codex-chosen", effort: "minimal" }
          ] satisfies ReadonlyArray<SessionAgentSettings>
        ) {
          yield* Ref.set(settings, sessionAgent)
          const answers = yield* attributor.attribute(
            request,
            (event) => Ref.update(activity, (events) => [...events, event.kind])
          )
          expect(answers).toEqual([{
            sessionId: "session-1",
            choice: { _tag: "Chosen", ticketKey: "PROJ-42", confidence: 0.9 }
          }])
          expect(yield* attributor.describe(describeRequest)).toEqual([{ id: "item-1", note: "Fixed validation" }])
        }
      }).pipe(Effect.provide(testRuntime(settings, calls)))
      expect(calls.map((command) => command.command)).toEqual(["claude", "claude", "codex", "codex", "codex", "codex"])
      const turns = calls.filter((command) => command.args.join(" ") !== "features list")
      expect(turns).toHaveLength(4)
      for (const command of turns) {
        expect(command.args[command.args.indexOf("--model") + 1]).toBe(`${command.command}-chosen`)
        expect(command.options.extendEnv).toBe(false)
        if (command.command === "claude") {
          expect(command.args[command.args.indexOf("--effort") + 1]).toBe("max")
          expect(command.args[command.args.indexOf("--tools") + 1]).toBe("")
        } else {
          expect(command.args).toContain("model_reasoning_effort=\"minimal\"")
          expect(command.args[command.args.indexOf("--sandbox") + 1]).toBe("read-only")
          expect(command.args).toContain("--ignore-user-config")
          expect(command.args).toContain("--ignore-rules")
          expect(command.args).toContain("shell_environment_policy.inherit=none")
          expect(command.args).toContain("web_search=\"disabled\"")
          expect(command.args).toContain("tools.view_image=false")
          expect(command.args[command.args.indexOf("shell_tool") - 1]).toBe("--disable")
          expect(command.args[command.args.indexOf("plugins") - 1]).toBe("--disable")
        }
      }
      const events = yield* Ref.get(activity)
      expect(events.filter((kind) => kind === "request")).toHaveLength(2)
      expect(events.filter((kind) => kind === "response")).toHaveLength(2)
      expect(events).toContain("status")
      expect(events).toContain("text")
    }))

  it.effect("rejects an unclassified Codex feature before either generation starts", () =>
    Effect.gen(function*() {
      const settings = yield* Ref.make<SessionAgentSettings>({ provider: "codex", model: null, effort: null })
      const calls: Array<ChildProcess.StandardCommand> = []
      yield* Effect.gen(function*() {
        const attributor = yield* SessionAttributor
        expect(Exit.isFailure(yield* Effect.exit(attributor.attribute(request)))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(attributor.describe(describeRequest)))).toBe(true)
      }).pipe(Effect.provide(testRuntime(settings, calls, "future_host_tool stable true")))
      expect(calls.map((command) => command.args)).toEqual([["features", "list"], ["features", "list"]])
    }))
})
