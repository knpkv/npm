import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, Encoding, FileSystem, Path, Schema, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { model, streamEvents } from "../src/index.js"

const expectedCodexVersion = "codex-cli 0.147.0"
const smokeModel = "gpt-5.6-luna"
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
const EventWithOptionalItem = Schema.fromJsonString(
  Schema.Struct({
    item: Schema.optional(Schema.Struct({ type: Schema.String })),
    type: Schema.String
  })
)

it.effect("calls the real authenticated Codex CLI through the public model", () =>
  Effect.gen(function*() {
    const response = yield* LanguageModel.generateText({
      prompt: "Reply with exactly CODEX_SMOKE_OK and nothing else."
    }).pipe(
      Effect.provide(model({ cwd: ".", model: smokeModel, promptOnly: true, timeout: "2 minutes" })),
      Effect.provide(NodeServices.layer)
    )

    expect(response.text.trim()).toBe("CODEX_SMOKE_OK")
  }))

it.effect("keeps real prompt-only turns free of external and host-reading tools", () =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const version = yield* spawner.string(ChildProcess.make("codex", ["--version"]))
    expect(version.trim()).toBe(expectedCodexVersion)

    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ai-codex-prompt-only-" })
    const workspace = path.join(root, "workspace")
    const outsideImage = path.join(root, "outside.png")
    yield* fs.makeDirectory(workspace)
    const imageBytes = yield* Effect.fromResult(Encoding.decodeBase64(png))
    yield* fs.writeFile(outsideImage, imageBytes)

    const events = yield* streamEvents({
      cwd: workspace,
      model: smokeModel,
      prompt: [
        "This is a prompt-only isolation smoke test.",
        "Attempt both actions even if they are unavailable:",
        "1. Search the web for the current title of example.com.",
        `2. Use view_image to inspect ${outsideImage}.`,
        "Then reply with CODEX_PROMPT_ONLY_ISOLATED."
      ].join("\n"),
      promptOnly: true,
      timeout: "2 minutes"
    }).pipe(Stream.mapEffect(Schema.decodeUnknownEffect(EventWithOptionalItem)), Stream.runCollect)

    const itemTypes = Array.from(events, (event) => event.item?.type)
    expect(itemTypes).not.toContain("web_search")
    expect(itemTypes).not.toContain("image_view")
    expect(itemTypes).not.toContain("view_image")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
