import { NodeServices } from "@effect/platform-node"
import { describe, expect, layer as testLayer } from "@effect/vitest"
import { makeDeterministicLanguageModel } from "@knpkv/ai-runtime"
import { defineContract, implement } from "@knpkv/capability"
import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Predicate, Schedule, Schema, Stream } from "effect"
import { AiError } from "effect/ai"
import type { LanguageModel } from "effect/ai"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { layer, ObjectRef, objectRefKey, register, RelayBackendUnavailable, RelayHarness } from "../src/index.js"
import type { RelayBackend, RelayEvent } from "../src/index.js"
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

const getApprovals = defineContract({
  name: "get_approvals",
  description: "Approval count of a pull request",
  access: "read",
  input: Schema.Struct({ pr: Schema.String }),
  output: Schema.Struct({ approvals: Schema.Number }),
  failure: Schema.Never,
  cites: () => [pr]
})
const approvals = implement(getApprovals, () => Effect.succeed({ approvals: 2 }))

const commentCalls: Array<string> = []
const postComment = implement(
  defineContract({
    name: "post_comment",
    description: "Post a comment on a pull request",
    access: "write",
    reversible: false,
    describe: (input: { readonly pr: string; readonly body: string }) => ({
      verb: "post comment",
      target: pr,
      args: { body: input.body }
    }),
    input: Schema.Struct({ pr: Schema.String, body: Schema.String }),
    output: Schema.Struct({ posted: Schema.Boolean }),
    failure: Schema.Never,
    cites: () => [pr]
  }),
  (input) =>
    Effect.sync(() => {
      commentCalls.push(input.body)
      return { posted: true }
    })
)

/** A Claude Code backend over a test model, installed at a fixed version unless `probe` says otherwise. */
const claude = (
  model: Layer.Layer<LanguageModel.LanguageModel>,
  probe: RelayBackend["probe"] = Effect.succeed("2.1.0 (Claude Code)")
): RelayBackend => ({
  id: "claude-code",
  name: "Claude Code",
  model,
  probe,
  signInFix: "Run claude and sign in with /login."
})

const harnessLayer = (model: Layer.Layer<LanguageModel.LanguageModel>, storePath: string) =>
  layer({
    storePath,
    instructions: "You are Relay.",
    capabilities: [register(approvals), register(postComment)],
    backends: [claude(model)]
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
        expect(events.find((event) => event._tag === "ToolStarted")).toMatchObject({ summary: "get approvals" })
        expect(events.find((event) => event._tag === "ToolFinished")).toMatchObject({
          ok: true,
          summary: "get approvals",
          cites: [pr]
        })
        expect(events.find((event) => event._tag === "ToolFinished")).not.toHaveProperty("receipt")
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
        // The card turns to past tense only on the server's outcome.
        expect(events.find((event) => event._tag === "ConfirmationResolved")).toMatchObject({ decision: "declined" })
        expect(commentCalls).toEqual([])
      }).pipe(Effect.scoped))

    it.effect("refuses a write with arguments it can't describe without asking or calling it declined", () =>
      Effect.gen(function*() {
        const store = yield* tempStore
        // A rule JSON Schema can't carry, so Pi's own argument check passes and the capability's decode refuses.
        const NotFriday = Schema.String.check(Schema.makeFilter((body: string) => body !== "ship it on Friday"))
        let posted = 0
        const strict = implement(
          defineContract({
            name: "post_comment",
            description: "Post a comment on a pull request",
            access: "write",
            reversible: false,
            describe: (input: { readonly pr: string; readonly body: string }) => ({
              verb: "post comment",
              target: pr,
              args: { body: input.body }
            }),
            input: Schema.Struct({ pr: Schema.String, body: NotFriday }),
            output: Schema.Struct({ posted: Schema.Boolean }),
            failure: Schema.Never
          }),
          () =>
            Effect.sync(() => {
              posted += 1
              return { posted: true }
            })
        )
        const model = toolThenAnswer("post_comment", { pr: "42", body: "ship it on Friday" })
        const relay = yield* relayIn(layer({
          storePath: store,
          instructions: "You are Relay.",
          capabilities: [register(strict)],
          backends: [claude(model.layer)]
        }))
        const events = yield* sendAndCollect(relay.events(pr), relay.send(pr, "Ship it", "req-bad-args"))
        expect(events.some((event) => event._tag === "ConfirmationRequired")).toBe(false)
        expect(posted).toBe(0)
        const lastPrompt = JSON.stringify(model.requests.at(-1)?.prompt.content)
        expect(lastPrompt).toContain("post_comment got invalid arguments")
        expect(lastPrompt).not.toContain("The user declined")
      }).pipe(Effect.scoped))

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
  const scripted = (
    script: ReadonlyArray<string | { readonly reply: string } | { readonly refused: string }>
  ) => {
    let calls = 0
    const model = makeDeterministicLanguageModel(() => {
      const step = script[Math.min(calls, script.length - 1)] ?? "script is empty"
      calls += 1
      if (!Predicate.isString(step) && "refused" in step) {
        return {
          _tag: "failure",
          failure: AiError.make({
            method: "generateText",
            module: "test",
            reason: new AiError.AuthenticationError({ kind: "InvalidKey", description: step.refused })
          })
        }
      }
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
          (event) =>
            event._tag === "ConfirmationRequired" ? relay.cancel(pr, "req-cancel").pipe(Effect.orDie) : Effect.void
        ).pipe(Effect.timeout("10 seconds"))
        expect(events.at(-1)).toMatchObject({ _tag: "Cancelled", runIds: ["req-cancel"] })
        expect(events.find((event) => event._tag === "ConfirmationResolved")).toMatchObject({ decision: "expired" })
        expect(commentCalls).toEqual([])
        // The card went away with its run: a late answer learns it expired, and a finished run can't be cancelled.
        const card = events.find((event) => event._tag === "ConfirmationRequired")
        const late = yield* relay.decide(card?._tag === "ConfirmationRequired" ? card.call : "", true).pipe(Effect.flip)
        expect(late.state).toEqual({ _tag: "Expired" })
        const again = yield* relay.cancel(pr, "req-cancel").pipe(Effect.flip)
        expect(again).toMatchObject({ _tag: "RelayRunNotActive", runId: "req-cancel" })
        const reconnect = yield* relay.events(pr).pipe(Stream.take(1), Stream.runCollect)
        expect(reconnect.map((event) => event._tag)).toEqual(["Snapshot"])
        const after = yield* relay.events(pr).pipe(
          Stream.takeUntil((event) => event._tag === "Snapshot"),
          Stream.runCollect
        )
        expect(after.some((event) => event._tag === "ConfirmationRequired")).toBe(false)
      }).pipe(Effect.scoped))
  })

  describe("runs and decisions", () => {
    it.effect("names a run by its requestId, in flight and when it ends", () =>
      Effect.gen(function*() {
        const store = yield* tempStore
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const slow = implement(getApprovals, () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ approvals: 2 })
          ))
        const model = toolThenAnswer("get_approvals", { pr: "42" })
        const relay = yield* relayIn(layer({
          storePath: store,
          instructions: "You are Relay.",
          capabilities: [register(slow)],
          backends: [claude(model.layer)]
        }))
        yield* relay.send(pr, "Approvals?", "req-named")
        yield* Deferred.await(started)
        const notThisOne = yield* relay.cancel(pr, "req-other").pipe(Effect.flip)
        expect(notThisOne._tag).toBe("RelayRunNotActive")
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
        expect(events[0]).toMatchObject({ _tag: "Snapshot", runIds: ["req-named"] })
        expect(events.at(-1)).toMatchObject({ _tag: "RunFinished", runIds: ["req-named"] })
      }).pipe(Effect.scoped))

    it.effect("announces the run, labels reads, and shows a confirmed write's receipt", () =>
      Effect.gen(function*() {
        const store = yield* tempStore
        const model = toolThenAnswer("post_comment", { pr: "42", body: "Ship it" })
        const relay = yield* relayIn(layer({
          storePath: store,
          instructions: "You are Relay.",
          capabilities: [
            register(approvals),
            register(postComment, {
              receipt: () => ({
                summary: "Comment posted",
                providerId: "comment-7",
                link: "https://example.invalid/42"
              })
            })
          ],
          backends: [claude(model.layer)]
        }))
        expect(yield* relay.session(pr)).toMatchObject({ cancel: true })
        const events = yield* sendAndCollect(
          relay.events(pr),
          relay.send(pr, "Comment Ship it", "req-receipt"),
          (event) =>
            event._tag === "ConfirmationRequired" ? relay.decide(event.call, true).pipe(Effect.orDie) : Effect.void
        )
        expect(events.find((event) => event._tag === "RunStarted")).toMatchObject({ runIds: ["req-receipt"] })
        expect(events.find((event) => event._tag === "ConfirmationResolved")).toMatchObject({ decision: "confirmed" })
        expect(events.find((event) => event._tag === "ToolStarted")).toMatchObject({ summary: "post comment" })
        expect(events.find((event) => event._tag === "ToolFinished")).toMatchObject({
          ok: true,
          summary: "Comment posted",
          receipt: { summary: "Comment posted", providerId: "comment-7", link: "https://example.invalid/42" }
        })
        // A reconnecting dock's Snapshot names each message, so it can key what it renders.
        const reconnect = yield* relay.events(pr).pipe(Stream.take(1), Stream.runCollect)
        expect(reconnect[0]).toMatchObject({
          _tag: "Snapshot",
          messages: expect.arrayContaining([
            expect.objectContaining({ id: expect.any(String), role: "user", text: "Comment Ship it" })
          ])
        })
      }).pipe(Effect.scoped))

    it.effect("tells a repeated or unknown answer why it can't be applied", () =>
      Effect.gen(function*() {
        commentCalls.length = 0
        const store = yield* tempStore
        const model = toolThenAnswer("post_comment", { pr: "42", body: "LGTM" })
        const relay = yield* relayIn(harnessLayer(model.layer, store))
        const answered: Array<string> = []
        yield* sendAndCollect(
          relay.events(pr),
          relay.send(pr, "Comment LGTM", "req-decide"),
          (event) =>
            event._tag === "ConfirmationRequired"
              ? Effect.sync(() => answered.push(event.call)).pipe(
                Effect.andThen(relay.decide(event.call, false)),
                Effect.orDie
              )
              : Effect.void
        )
        const repeated = yield* relay.decide(answered[0] ?? "", true).pipe(Effect.flip)
        expect(repeated.state).toEqual({ _tag: "Decided", allow: false })
        const unknown = yield* relay.decide("never-asked", true).pipe(Effect.flip)
        expect(unknown.state).toEqual({ _tag: "Unknown" })
        expect(commentCalls).toEqual([])
      }).pipe(Effect.scoped))
  })

  describe("backends", () => {
    const codex = (model: Layer.Layer<LanguageModel.LanguageModel>): RelayBackend => ({
      id: "codex-cli",
      name: "Codex",
      model,
      probe: Effect.fail(new RelayBackendUnavailable({ cause: "NotInstalled", fix: "Install Codex." })),
      signInFix: "Run codex login."
    })

    it.effect("starts unverified, turns ready when a turn answers, and says when the CLI is missing", () =>
      Effect.gen(function*() {
        const store = yield* tempStore
        const model = scripted([{ reply: "Hi." }])
        const relay = yield* relayIn(layer<never>({
          storePath: store,
          instructions: "You are Relay.",
          capabilities: [],
          backends: [claude(model.layer), codex(model.layer)]
        }))
        expect(yield* relay.backends).toEqual([
          { _tag: "Unverified", backend: "claude-code", label: "Claude Code", version: "2.1.0 (Claude Code)" },
          { _tag: "Unavailable", backend: "codex-cli", label: "Codex", cause: "NotInstalled", fix: "Install Codex." }
        ])
        yield* sendAndCollect(relay.events(pr), relay.send(pr, "Hi", "req-ready"))
        expect((yield* relay.backends)[0]).toMatchObject({ _tag: "Ready", version: "2.1.0 (Claude Code)" })
      }).pipe(Effect.scoped))

    it.effect("marks a backend signed out when the CLI refuses its login", () =>
      Effect.gen(function*() {
        const store = yield* tempStore
        const model = scripted([{ refused: "Not logged in" }])
        const relay = yield* relayIn(harnessLayer(model.layer, store))
        yield* sendAndCollect(relay.events(pr), relay.send(pr, "Hi", "req-signed-out")).pipe(
          Effect.timeout("20 seconds")
        )
        expect((yield* relay.backends)[0]).toEqual({
          _tag: "Unavailable",
          backend: "claude-code",
          label: "Claude Code",
          version: "2.1.0 (Claude Code)",
          cause: "SignedOut",
          fix: "Run claude and sign in with /login."
        })
      }).pipe(Effect.scoped), 30_000)

    it.effect("switches a session's backend from its next turn, and only to a configured one", () =>
      Effect.gen(function*() {
        const store = yield* tempStore
        const claudeModel = scripted([{ reply: "From Claude." }])
        const codexModel = scripted([{ reply: "From Codex." }])
        const relay = yield* relayIn(layer<never>({
          storePath: store,
          instructions: "You are Relay.",
          capabilities: [],
          backends: [claude(claudeModel.layer), codex(codexModel.layer)]
        }))
        expect((yield* relay.session(pr)).backend).toBe("claude-code")
        yield* sendAndCollect(relay.events(pr), relay.send(pr, "Hi", "req-codex", "codex-cli"))
        expect((yield* relay.session(pr)).backend).toBe("codex-cli")
        expect([claudeModel.calls(), codexModel.calls()]).toEqual([0, 1])
      }).pipe(Effect.scoped))

    it.effect("refuses a backend the product didn't configure", () =>
      Effect.gen(function*() {
        const store = yield* tempStore
        const relay = yield* relayIn(harnessLayer(scripted([{ reply: "Hi." }]).layer, store))
        const refused = yield* relay.send(pr, "Hi", "req-unconfigured", "codex-cli").pipe(Effect.flip)
        expect(refused).toMatchObject({ _tag: "RelayBackendNotConfigured", backend: "codex-cli" })
        expect((yield* relay.session(pr)).backend).toBe("claude-code")
      }).pipe(Effect.scoped))
  })

  describe("tool results", () => {
    const AwsDenied = Schema.TaggedStruct("AwsDenied", { message: Schema.String, fix: Schema.String })
    const broken = implement(
      defineContract({
        name: "get_approvals",
        description: "Approval count of a pull request",
        access: "read",
        input: Schema.Struct({ pr: Schema.String }),
        output: Schema.Struct({ approvals: Schema.Number }),
        failure: AwsDenied,
        cites: () => [pr]
      }),
      () => Effect.fail(AwsDenied.make({ message: "AccessDenied", fix: "Grant codecommit:GetPullRequest" }))
    )

    it.effect("reports a failed or declined call as ok: false", () =>
      Effect.gen(function*() {
        const store = yield* tempStore
        const model = toolThenAnswer("get_approvals", { pr: "42" })
        const relay = yield* relayIn(layer({
          storePath: store,
          instructions: "You are Relay.",
          capabilities: [register(broken)],
          backends: [claude(model.layer)]
        }))
        const events = yield* sendAndCollect(relay.events(pr), relay.send(pr, "Approvals?", "req-broken"))
        expect(events.find((event) => event._tag === "ToolFinished")).toMatchObject({ ok: false })
        // The model reads the declared reason and fix, as the capability wrote them.
        const lastPrompt = JSON.stringify(model.requests.at(-1)?.prompt.content)
        expect(lastPrompt).toContain("AccessDenied — Grant codecommit:GetPullRequest")
      }).pipe(Effect.scoped))

    it.effect("never shows the model a defect's internals", () =>
      Effect.gen(function*() {
        const store = yield* tempStore
        const model = toolThenAnswer("get_approvals", { pr: "42" })
        const crashing = implement(getApprovals, () => Effect.die(new Error("secret stack detail")))
        const relay = yield* relayIn(layer({
          storePath: store,
          instructions: "You are Relay.",
          capabilities: [register(crashing)],
          backends: [claude(model.layer)]
        }))
        yield* sendAndCollect(relay.events(pr), relay.send(pr, "Approvals?", "req-defect"))
        const lastPrompt = JSON.stringify(model.requests.at(-1)?.prompt.content)
        expect(lastPrompt).toContain("get_approvals failed unexpectedly")
        expect(lastPrompt).not.toContain("secret stack detail")
      }).pipe(Effect.scoped))

    it.effect("replays a call still running to a dock that attaches mid-run", () =>
      Effect.gen(function*() {
        const store = yield* tempStore
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const slow = implement(getApprovals, () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ approvals: 2 })
          ))
        const model = toolThenAnswer("get_approvals", { pr: "42" })
        const relay = yield* relayIn(layer({
          storePath: store,
          instructions: "You are Relay.",
          capabilities: [register(slow)],
          backends: [claude(model.layer)]
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
