/** @effect-diagnostics strictEffectProvide:skip-file */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { makeDeterministicLanguageModel } from "@knpkv/ai-runtime"
import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Schedule, Schema, Stream } from "effect"
import type { LanguageModel } from "effect/ai"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { defineCapability, layer, ObjectRef, register, RelayHarness } from "../src/index.js"
import type { RelayEvent } from "../src/index.js"
import { relayModels, relayProvider } from "../src/piProvider.js"

const pr = ObjectRef.make({ product: "codecommit", kind: "pull-request", id: "acct/repo/42" })

/** A model that calls the named tool once, then answers from its result. Decided from the prompt alone. */
const toolThenAnswer = (tool: string, args: Record<string, Schema.Json>) =>
  makeDeterministicLanguageModel((request) => {
    const prompt = JSON.stringify(request.prompt.content)
    const result = /TOOL (RESULT|ERROR) \w+ \(/u.exec(prompt)
    const turn = result !== null
      ? { reply: result[1] === "ERROR" ? "It did not happen." : "The PR has 2 approvals.", toolCalls: [] }
      : { reply: "", toolCalls: [{ name: tool, arguments: args }] }
    return { _tag: "response", parts: [{ type: "text", text: JSON.stringify(turn) }] }
  })

const approvals = defineCapability({
  name: "get_approvals",
  description: "Approval count of a pull request",
  input: Schema.Struct({ pr: Schema.String }),
  output: Schema.Struct({ approvals: Schema.Number }),
  effect: "read",
  reversible: true,
  describe: () => ({ verb: "read approvals", target: pr, args: {} }),
  cites: () => [pr],
  handler: () => Effect.succeed({ approvals: 2 })
})

const commentCalls: Array<string> = []
const postComment = defineCapability({
  name: "post_comment",
  description: "Post a comment on a pull request",
  input: Schema.Struct({ pr: Schema.String, body: Schema.String }),
  output: Schema.Struct({ posted: Schema.Boolean }),
  effect: "write",
  reversible: false,
  describe: (input) => ({ verb: "post comment", target: pr, args: { body: input.body } }),
  cites: () => [pr],
  handler: (input) =>
    Effect.sync(() => {
      commentCalls.push(input.body)
      return { posted: true }
    })
})

const harnessLayer = (model: Layer.Layer<LanguageModel.LanguageModel>, storePath: string) =>
  layer({
    storePath,
    instructions: "You are Relay.",
    capabilities: [register(approvals), register(postComment)],
    backends: [{ id: "claude-code", name: "Claude Code", model }]
  })

const tempStore = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return path.join(yield* fs.makeTempDirectoryScoped(), "relay.sqlite")
})

/** Build the harness in the test's scope, so it stays open until the test ends. */
const relayIn = <E, R>(harness: Layer.Layer<RelayHarness, E, R>) =>
  Effect.map(Layer.build(harness), (context) => Context.get(context, RelayHarness))

/**
 * Subscribe like the dock does: attach, wait for the `Snapshot`, then send, and collect until the run
 * ends. Sending before attaching would race a fast run past the subscription.
 */
const sendAndCollect = (
  events: Stream.Stream<RelayEvent, unknown>,
  send: Effect.Effect<void, unknown>,
  onEvent: (event: RelayEvent) => Effect.Effect<void> = () => Effect.void
) =>
  Effect.gen(function*() {
    const attached = yield* Deferred.make<void>()
    const collecting = yield* Effect.forkChild(
      events.pipe(
        Stream.tap((event) => (event._tag === "Snapshot" ? Deferred.succeed(attached, undefined) : onEvent(event))),
        Stream.takeUntil((event) => event._tag === "RunFinished" || event._tag === "RunFailed"),
        Stream.runCollect
      )
    )
    yield* Deferred.await(attached)
    yield* send
    return yield* Fiber.join(collecting)
  })

describe("RelayHarness", () => {
  it.effect("runs a read capability without asking and answers from its result", () =>
    Effect.gen(function*() {
      const store = yield* tempStore
      const model = toolThenAnswer("get_approvals", { pr: "42" })
      const relay = yield* relayIn(harnessLayer(model.layer, store))
      const events = yield* sendAndCollect(relay.events(pr), relay.send(pr, "How many approvals?", "req-1"))
      const tags = events.map((event) => event._tag)
      expect(tags[0]).toBe("Snapshot")
      expect(tags).toContain("ToolStarted")
      expect(tags).not.toContain("ConfirmationRequired")
      expect(events.find((event) => event._tag === "ToolFinished")).toMatchObject({ ok: true, cites: [pr] })
      expect(events.flatMap((event) => (event._tag === "TextDelta" ? [event.text] : [])).join("")).toContain(
        "2 approvals"
      )
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("asks before a write and never runs it when the user declines", () =>
    Effect.gen(function*() {
      commentCalls.length = 0
      const store = yield* tempStore
      const model = toolThenAnswer("post_comment", { pr: "42", body: "LGTM" })
      const relay = yield* relayIn(harnessLayer(model.layer, store))
      const events = yield* sendAndCollect(
        relay.events(pr),
        relay.send(pr, "Comment LGTM", "req-2"),
        (event) =>
          event._tag === "ConfirmationRequired" ? relay.decide(event.call, false).pipe(Effect.orDie) : Effect.void
      )
      const confirmation = events.find((event) => event._tag === "ConfirmationRequired")
      expect(confirmation).toMatchObject({
        action: { verb: "post comment", args: { body: "LGTM" } },
        reversible: false
      })
      expect(commentCalls).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("shows a pending confirmation again to a dock that reconnects", () =>
    Effect.gen(function*() {
      commentCalls.length = 0
      const store = yield* tempStore
      const model = toolThenAnswer("post_comment", { pr: "42", body: "ship it" })
      const relay = yield* relayIn(harnessLayer(model.layer, store))
      // First dock: sees the confirmation, then goes away without answering.
      const first = yield* sendAndCollect(
        relay.events(pr).pipe(Stream.takeUntil((event) => event._tag === "ConfirmationRequired")),
        relay.send(pr, "Comment ship it", "req-3")
      )
      const asked = first.find((event) => event._tag === "ConfirmationRequired")
      expect(asked).toBeDefined()
      // Second dock: its Snapshot is followed by the same confirmation; answering it finishes the run.
      const second = yield* relay.events(pr).pipe(
        Stream.tap((event) =>
          event._tag === "ConfirmationRequired" ? relay.decide(event.call, true).pipe(Effect.orDie) : Effect.void
        ),
        Stream.takeUntil((event) => event._tag === "RunFinished"),
        Stream.runCollect
      )
      expect(second.slice(0, 2).map((event) => event._tag)).toEqual(["Snapshot", "ConfirmationRequired"])
      expect(commentCalls).toEqual(["ship it"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses a second owner of the same store and keeps it owner-only", () =>
    Effect.gen(function*() {
      const store = yield* tempStore
      const model = toolThenAnswer("get_approvals", { pr: "42" })
      yield* relayIn(harnessLayer(model.layer, store))
      const second = yield* relayIn(harnessLayer(model.layer, store)).pipe(Effect.flip)
      expect(second._tag).toBe("RelayStoreLocked")
      // Sessions hold conversation content: owner-only directory and database.
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      expect((yield* fs.stat(store)).mode & 0o777).toBe(0o600)
      expect((yield* fs.stat(path.dirname(store))).mode & 0o777).toBe(0o700)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

describe("relayModels", () => {
  it("registers only Relay's own providers, never pi-ai's catalog or its OAuth providers", () => {
    const run = () => Promise.reject(new Error("not called"))
    const models = relayModels([
      relayProvider("claude-code", "Claude Code", run, () => 0),
      relayProvider("codex-cli", "Codex", run, () => 0)
    ])
    expect(models.getProviders().map((provider) => provider.id).sort()).toEqual(["claude-code", "codex-cli"])
    expect(models.getProvider("anthropic")).toBeUndefined()
    expect(models.getProvider("openai-codex")).toBeUndefined()
  })
})

describe("crash safety", () => {
  it.live("a run killed inside a confirmed write resumes without repeating the write", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped()
      const store = path.join(directory, "relay.sqlite")
      const marker = path.join(directory, "posted.log")
      const child = path.join(import.meta.dirname, "fixtures", "crash-child.ts")
      const tsx = path.join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsx")
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const running = yield* spawner.spawn(ChildProcess.make(tsx, [child, "run", store, marker]))
      yield* fs.exists(marker).pipe(
        Effect.repeat({ until: (exists) => exists, schedule: Schedule.spaced("50 millis") }),
        Effect.timeout("20 seconds")
      )
      yield* running.kill({ killSignal: "SIGKILL" })
      yield* running.exitCode.pipe(Effect.ignore)

      const resumed = yield* spawner.string(ChildProcess.make(tsx, [child, "resume", store, marker]))
      expect(resumed).toContain("RESUMED_AND_ANSWERED")
      expect(yield* fs.readFileString(marker)).toBe("posted LGTM\n")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 60_000)
})
