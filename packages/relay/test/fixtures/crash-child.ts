/**
 * Child process for the crash test: `run` approves a comment and dies inside it (the parent sends
 * SIGKILL); `resume` reopens the store and prints the session once the interrupted run settles.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { defineContract, implement } from "@knpkv/capability"
import { Console, Effect, FileSystem, Layer, Schedule, Schema, Stdio, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import type { Response } from "effect/ai"
import { layer, RelayHarness } from "../../src/harness.ts"
import { ObjectRef } from "../../src/model.ts"
import { register } from "../../src/registry.ts"

const Arguments = Schema.Tuple([Schema.Literals(["run", "resume"]), Schema.String, Schema.String])
const pr = ObjectRef.make({ product: "codecommit", kind: "pull-request", id: "acct/repo/42" })

const model = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: (request) =>
      Effect.sync(() => {
        const prompt = JSON.stringify(request.prompt.content)
        const settled = /TOOL (RESULT|ERROR) post_comment \(/u.test(prompt)
        const turn = settled
          ? { reply: "The comment may not have been posted; I did not repost it.", toolCalls: [] }
          : { reply: "", toolCalls: [{ name: "post_comment", arguments: { pr: "42", body: "LGTM" } }] }
        const part: Response.TextPartEncoded = { type: "text", text: JSON.stringify(turn) }
        return [part]
      }),
    streamText: () => Stream.die("not used")
  })
)

const postCommentContract = defineContract({
  name: "post_comment",
  description: "Post a comment",
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
})

const postCommentTo = (markerPath: string) =>
  implement(postCommentContract, (input) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(markerPath, `posted ${input.body}\n`, { flag: "a" })
      // The parent kills this process here.
      yield* Effect.sleep("30 seconds")
      return { posted: true }
    }).pipe(Effect.orDie))

const program = (phase: "run" | "resume") =>
  Effect.gen(function*() {
    const relay = yield* RelayHarness
    const events = relay.events(pr).pipe(
      Stream.tap((
        event
      ) => (event._tag === "ConfirmationRequired" ? Effect.orDie(relay.decide(pr, event.call, true)) : Effect.void)),
      Stream.tap((event) => Console.log(JSON.stringify(event)))
    )
    if (phase === "run") {
      yield* Effect.forkChild(Stream.runDrain(events))
      yield* Effect.sleep("200 millis")
      yield* relay.send(pr, "Comment LGTM", "req-crash")
      return yield* Effect.never
    }
    // resume: the reopened harness continues the interrupted run by itself. Poll the session's snapshot
    // until the model's answer to the interrupted call is there, then print it.
    const answered = relay.events(pr).pipe(
      Stream.take(1),
      Stream.runHead,
      Effect.map((head) =>
        head._tag === "Some" && head.value._tag === "Snapshot" &&
        head.value.messages.some((message) => message.role === "relay" && message.text.includes("not have been posted"))
      )
    )
    yield* answered.pipe(
      Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("200 millis") }),
      Effect.timeout("15 seconds")
    )
    yield* Console.log("RESUMED_AND_ANSWERED")
  })

const main = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const [phase, storePath, markerPath] = yield* Schema.decodeUnknownEffect(Arguments)(yield* stdio.args)
  const harness = layer({
    storePath,
    instructions: "You are Relay.",
    capabilities: [register(postCommentTo(markerPath))],
    backends: [{ id: "claude-code", name: "Claude Code", model, probe: Effect.succeed("test"), signInFix: "Sign in." }]
  })
  const context = yield* Layer.build(harness)
  return yield* Effect.provide(program(phase), context)
})

NodeRuntime.runMain(Effect.scoped(main).pipe(Effect.provide(NodeServices.layer)))
