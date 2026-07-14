import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { model } from "../src/index.js"

it.effect("calls the real authenticated Codex CLI through the public model", () =>
  Effect.gen(function*() {
    const response = yield* LanguageModel.generateText({
      prompt: "Reply with exactly CODEX_SMOKE_OK and nothing else."
    }).pipe(
      Effect.provide(model({ cwd: ".", timeout: "2 minutes" })),
      Effect.provide(NodeServices.layer)
    )

    expect(response.text.trim()).toBe("CODEX_SMOKE_OK")
  }))
