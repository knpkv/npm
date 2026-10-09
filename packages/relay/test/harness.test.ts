import { NodeServices } from "@effect/platform-node"
import { describe, expect, layer as testLayer } from "@effect/vitest"
import { makeDeterministicLanguageModel } from "@knpkv/ai-runtime"
import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Predicate, Schedule, Schema, Stream } from "effect"
import { AiError } from "effect/ai"
import type { LanguageModel } from "effect/ai"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { defineCapability, layer, ObjectRef, objectRefKey, register, RelayHarness } from "../src/index.js"
import type { RelayEvent } from "../src/index.js"
import { relayModels, relayProvider } from "../src/piProvider.js"

const pr = ObjectRef.make({ product: "codecommit", kind: "pull-request", id: "acct/repo/42" })

/**
 * A model that calls the named tool once, then answers from its result. Decided from the prompt alone;
 * every prompt it sees is appended to `prompts`, so a test can read the tool result the model was given.
 */
const toolThenAnswer = (tool: string, args: Record<string, Schema.Json>, prompts: Array<string> = []) =>
  makeDeterministicLanguageModel((request) => {
    const prompt = JSON.stringify(request.prompt.content)
    prompts.push(prompt)
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

const hostCalls: Array<string> = []
const runShell = defineCapability({
  name: "run_shell",
  description: "Run a command on the host",
  input: Schema.Struct({ cmd: Schema.String }),
  output: Schema.Struct({ ok: Schema.Boolean }),
  effect: "host",
  reversible: false,
  describe: (input) => ({ verb: "run", target: pr, args: { cmd: input.cmd } }),
  cites: () => [pr],
  handler: (input) =>
    Effect.sync(() => {
      hostCalls.push(input.cmd)
      return { ok: true }
    })
})

/** A write whose input has a check JSON Schema cannot express, so only the capability's decode rejects it. */
const postNonEmpty = defineCapability({
  name: "post_non_empty",
  description: "Post a non-blank comment on a pull request",
  input: Schema.Struct({
    pr: Schema.String,
    body: Schema.String.check(Schema.makeFilter((body: string) => body.trim() !== ""))
  }),
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
    capabilities: [register(approvals), register(postComment), register(runShell), register(postNonEmpty)],
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
        Stream.takeUntil((event) =>
          event._tag === "RunFinished" || event._tag === "RunFailed" || event._tag === "Cancelled"
        ),
        Stream.runCollect
      )
    )
    yield* Deferred.await(attached)
    yield* send
    return yield* Fiber.join(collecting)
  })

// Platform services for every test; the live clock, since Pi schedules its retries on real time.
testLayer(NodeServices.layer, { excludeTestServices: true })("relay", (it) => {
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
      }).pipe(Effect.scoped))

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
      }).pipe(Effect.scoped))

    it.effect("runs a write only after the person confirms it", () =>
      Effect.gen(function*() {
        commentCalls.length = 0
        const store = yield* tempStore
        const model = toolThenAnswer("post_comment", { pr: "42", body: "approved" })
        const relay = yield* relayIn(harnessLayer(model.layer, store))
        const atCard: Array<ReadonlyArray<string>> = []
        yield* sendAndCollect(relay.events(pr), relay.send(pr, "Comment approved", "req-confirm"), (event) =>
          event._tag === "ConfirmationRequired"
            ? Effect.sync(() =>
              atCard.push([...commentCalls])
            ).pipe(
              Effect.andThen(relay.decide(event.call, true).pipe(Effect.orDie))
            )
            : Effect.void)
        expect(atCard).toEqual([[]])
        expect(commentCalls).toEqual(["approved"])
      }).pipe(Effect.scoped))

    it.effect("refuses a host capability without asking, and tells the model why", () =>
      Effect.gen(function*() {
        hostCalls.length = 0
        const prompts: Array<string> = []
        const store = yield* tempStore
        const model = toolThenAnswer("run_shell", { cmd: "rm -rf /" }, prompts)
        const relay = yield* relayIn(harnessLayer(model.layer, store))
        const events = yield* sendAndCollect(relay.events(pr), relay.send(pr, "Clean up", "req-host"), (event) =>
          event._tag === "ConfirmationRequired" ? relay.decide(event.call, true).pipe(Effect.orDie) : Effect.void)
        expect(events.map((event) =>
          event._tag
        )).not.toContain("ConfirmationRequired")
        expect(events.find((event) =>
          event._tag === "ToolFinished"
        )).toMatchObject({ ok: false })
        expect(prompts.at(-1)).toContain("run_shell needs a herdr Approval")
        expect(hostCalls).toEqual([])
      }).pipe(Effect.scoped))

    it.effect(
      "refuses arguments only the capability's decode rejects, without asking or saying the person declined",
      () =>
        Effect.gen(function*() {
          commentCalls.length = 0
          const prompts: Array<string> = []
          const store = yield* tempStore
          const model = toolThenAnswer("post_non_empty", { pr: "42", body: "  " }, prompts)
          const relay = yield* relayIn(harnessLayer(model.layer, store))
          const events = yield* sendAndCollect(
            relay.events(pr),
            relay.send(pr, "Comment nothing", "req-invalid"),
            (event) =>
              event._tag === "ConfirmationRequired" ? relay.decide(event.call, true).pipe(Effect.orDie) : Effect.void
          )
          expect(events.map((event) => event._tag)).not.toContain("ConfirmationRequired")
          expect(prompts.at(-1)).toContain("post_non_empty got invalid arguments, so nobody was asked")
          expect(prompts.at(-1)).not.toContain("declined")
          expect(commentCalls).toEqual([])
        }).pipe(Effect.scoped)
    )

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
        // The reconnecting dock sees the run as it stands: the waiting call, then its card.
        expect(second.slice(0, 3).map((event) => event._tag)).toEqual([
          "Snapshot",
          "ToolStarted",
          "ConfirmationRequired"
        ])
        expect(commentCalls).toEqual(["ship it"])
      }).pipe(Effect.scoped))

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
      }).pipe(Effect.scoped))
  })

  describe("store links", () => {
    it.effect("refuses a store directory that is a link, and leaves the link's target untouched", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped()
        const elsewhere = path.join(root, "elsewhere")
        yield* fs.makeDirectory(elsewhere, { mode: 0o755 })
        const linked = path.join(root, "relay")
        yield* fs.symlink(elsewhere, linked)
        const model = toolThenAnswer("get_approvals", { pr: "42" })
        const failure = yield* relayIn(harnessLayer(model.layer, path.join(linked, "relay.sqlite"))).pipe(Effect.flip)
        expect(failure).toMatchObject({ _tag: "RelayStoreLinked", path: linked })
        expect((yield* fs.stat(elsewhere)).mode & 0o777).toBe(0o755)
        expect(yield* fs.readDirectory(elsewhere)).toEqual([])
      }).pipe(Effect.scoped))

    it.effect("refuses a database that is a link, even one pointing at nothing yet", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped()
        const store = path.join(root, "relay", "relay.sqlite")
        const target = path.join(root, "target.sqlite")
        yield* fs.makeDirectory(path.dirname(store), { mode: 0o700 })
        yield* fs.symlink(target, store)
        const model = toolThenAnswer("get_approvals", { pr: "42" })
        const failure = yield* relayIn(harnessLayer(model.layer, store)).pipe(Effect.flip)
        expect(failure).toMatchObject({ _tag: "RelayStoreLinked", path: store })
        expect(yield* fs.exists(target)).toBe(false)
      }).pipe(Effect.scoped))
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
    it.effect(
      "a run killed inside a confirmed write resumes without repeating the write",
      () =>
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
        }).pipe(Effect.scoped),
      60_000
    )
  })

  /** A model whose turns come from `script`, in order; a string is an error with that text. */
  const scripted = (script: ReadonlyArray<string | { readonly reply: string }>) => {
    let calls = 0
    const model = makeDeterministicLanguageModel(() => {
      const step = script[Math.min(calls, script.length - 1)] ?? "script is empty"
      calls += 1
      return Predicate.isString(step)
        ? {
          _tag: "failure",
          failure: AiError.make({
            method: "generateText",
            module: "test",
            reason: new AiError.UnknownError({ description: step })
          })
        }
        : { _tag: "response", parts: [{ type: "text", text: JSON.stringify({ reply: step.reply, toolCalls: [] }) }] }
    })
    return { layer: model.layer, calls: () => calls }
  }

  describe("run outcomes", () => {
    it.effect("retries a transient backend failure on the live clock and finishes", () =>
      Effect.gen(function*() {
        const store = yield* tempStore
        const model = scripted(["overloaded 503", { reply: "Back." }])
        const relay = yield* relayIn(harnessLayer(model.layer, store))
        const events = yield* sendAndCollect(relay.events(pr), relay.send(pr, "Hi", "req-retry")).pipe(
          Effect.timeout("20 seconds")
        )
        expect(model.calls()).toBe(2)
        expect(events.at(-1)?._tag).toBe("RunFinished")
      }).pipe(Effect.scoped), 30_000)

    it.effect("reports a backend that can't answer as RunFailed with its cause", () =>
      Effect.gen(function*() {
        const store = yield* tempStore
        const model = scripted(["SignedOut: sign in to Claude Code first"])
        const relay = yield* relayIn(harnessLayer(model.layer, store))
        const events = yield* sendAndCollect(relay.events(pr), relay.send(pr, "Hi", "req-fail"))
        const last = events.at(-1)
        expect(last?._tag).toBe("RunFailed")
        expect(last?._tag === "RunFailed" && last.cause).toContain("sign in")
      }).pipe(Effect.scoped))

    it.effect("cancelling while a confirmation waits ends the run as Cancelled and withdraws the card", () =>
      Effect.gen(function*() {
        commentCalls.length = 0
        const store = yield* tempStore
        const model = toolThenAnswer("post_comment", { pr: "42", body: "never" })
        const relay = yield* relayIn(harnessLayer(model.layer, store))
        const events = yield* sendAndCollect(
          relay.events(pr),
          relay.send(pr, "Comment never", "req-cancel"),
          (event) => event._tag === "ConfirmationRequired" ? relay.cancel(pr).pipe(Effect.orDie) : Effect.void
        ).pipe(Effect.timeout("10 seconds"))
        expect(events.at(-1)?._tag).toBe("Cancelled")
        expect(commentCalls).toEqual([])
        const reconnect = yield* relay.events(pr).pipe(Stream.take(1), Stream.runCollect)
        expect(reconnect.map((event) => event._tag)).toEqual(["Snapshot"])
        const after = yield* relay.events(pr).pipe(
          Stream.takeUntil((event) => event._tag === "Snapshot"),
          Stream.runCollect
        )
        expect(after.some((event) => event._tag === "ConfirmationRequired")).toBe(false)
      }).pipe(Effect.scoped))
  })

  describe("tool results", () => {
    const broken = defineCapability({
      name: "get_approvals",
      description: "Approval count of a pull request",
      input: Schema.Struct({ pr: Schema.String }),
      output: Schema.Struct({ approvals: Schema.Number }),
      effect: "read",
      reversible: true,
      describe: () => ({ verb: "read approvals", target: pr, args: {} }),
      cites: () => [pr],
      handler: () => Effect.fail({ _tag: "AwsDenied", message: "AccessDenied" })
    })

    it.effect("reports a failed or declined call as ok: false", () =>
      Effect.gen(function*() {
        const store = yield* tempStore
        const model = toolThenAnswer("get_approvals", { pr: "42" })
        const relay = yield* relayIn(layer({
          storePath: store,
          instructions: "You are Relay.",
          capabilities: [register(broken)],
          backends: [{ id: "claude-code", name: "Claude Code", model: model.layer }]
        }))
        const events = yield* sendAndCollect(relay.events(pr), relay.send(pr, "Approvals?", "req-broken"))
        expect(events.find((event) => event._tag === "ToolFinished")).toMatchObject({ ok: false })
      }).pipe(Effect.scoped))

    it.effect("replays a call still running to a dock that attaches mid-run", () =>
      Effect.gen(function*() {
        const store = yield* tempStore
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const slow = defineCapability({
          name: "get_approvals",
          description: "Approval count of a pull request",
          input: Schema.Struct({ pr: Schema.String }),
          output: Schema.Struct({ approvals: Schema.Number }),
          effect: "read",
          reversible: true,
          describe: () => ({ verb: "read approvals", target: pr, args: {} }),
          cites: () => [pr],
          handler: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ approvals: 2 })
            )
        })
        const model = toolThenAnswer("get_approvals", { pr: "42" })
        const relay = yield* relayIn(layer({
          storePath: store,
          instructions: "You are Relay.",
          capabilities: [register(slow)],
          backends: [{ id: "claude-code", name: "Claude Code", model: model.layer }]
        }))
        yield* relay.send(pr, "Approvals?", "req-slow")
        yield* Deferred.await(started)
        const attached = yield* Deferred.make<void>()
        const late = yield* Effect.forkChild(
          relay.events(pr).pipe(
            Stream.tap((event) => (event._tag === "Snapshot" ? Deferred.succeed(attached, undefined) : Effect.void)),
            Stream.takeUntil((event) => event._tag === "RunFinished"),
            Stream.runCollect
          )
        )
        yield* Deferred.await(attached)
        yield* Deferred.succeed(release, undefined)
        const events = yield* Fiber.join(late)
        const tags = events.map((event) => event._tag)
        expect(tags.slice(0, 2)).toEqual(["Snapshot", "ToolStarted"])
        expect(events.find((event) => event._tag === "ToolStarted")).toMatchObject({ input: { pr: "42" } })
        expect(tags).toContain("ToolFinished")
      }).pipe(Effect.scoped))
  })

  describe("objectRefKey", () => {
    it("keeps refs whose fields contain separators apart", () => {
      const a = ObjectRef.make({ product: "codecommit", kind: "a\u0000b", id: "c" })
      const b = ObjectRef.make({ product: "codecommit", kind: "a", id: "b\u0000c" })
      expect(objectRefKey(a)).not.toBe(objectRefKey(b))
      expect(objectRefKey(pr)).toBe(objectRefKey(ObjectRef.make({ ...pr })))
    })
  })
})
