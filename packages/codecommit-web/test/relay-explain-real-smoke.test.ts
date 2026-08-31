/** @effect-diagnostics missingEffectContext:skip-file */
import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { streamEvents } from "@knpkv/ai-codex"
import { Effect, FileSystem, Option, Schema, Stream } from "effect"

import { parseRelayReviewResult, relayReviewOutputSchema } from "../src/server/review/PullRequestReview.js"

const AgentMessage = Schema.fromJsonString(Schema.Struct({
  type: Schema.Literal("item.completed"),
  item: Schema.Struct({ type: Schema.Literal("agent_message"), text: Schema.String })
}))

it.effect("returns a contract-valid Explain result from the authenticated model", () =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-relay-explain-smoke-" })
    const message = yield* streamEvents({
      cwd: workspace,
      model: "gpt-5.6-luna",
      outputSchema: relayReviewOutputSchema("explain"),
      prompt: [
        "Explain this synthetic patch in one JSON object.",
        "Return findings: [], a nonempty verdict, and a nonempty explanation.",
        "diff --git a/retry.ts b/retry.ts",
        "-export const retries = 2",
        "+export const retries = 3"
      ].join("\n"),
      promptOnly: true,
      timeout: "2 minutes"
    }).pipe(
      Stream.map(Schema.decodeUnknownOption(AgentMessage)),
      Stream.filter(Option.isSome),
      Stream.map(({ value }) => value.item.text),
      Stream.runLast
    )
    const parsed = parseRelayReviewResult(Option.getOrElse(message, () => ""), "explain")
    expect(Option.isSome(parsed)).toBe(true)
    if (Option.isSome(parsed)) {
      expect(parsed.value.findings).toEqual([])
      expect(parsed.value.explanation).toBeTruthy()
    }
  }).pipe(
    Effect.scoped,
    // The opt-in smoke runner owns this model call's complete runtime.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(NodeServices.layer)
  ))
