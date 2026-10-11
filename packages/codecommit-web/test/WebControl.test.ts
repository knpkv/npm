import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Config, ConfigProvider, Effect, FileSystem, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as WebControl from "../src/server/internal/WebControl.js"

const fixture = Layer.unwrap(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "product-control-" })
  return Layer.mergeAll(
    ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home })),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 401 })))
      )
    )
  )
})).pipe(Layer.provideMerge(NodeServices.layer))
describe("CodeCommit control adapter", () => {
  it.layer(fixture)((it) =>
    it.effect("retains its path and product-specific failures", () =>
      Effect.gen(function*() {
        const file = yield* WebControl.controlFilePath
        expect(file).toBe(`${yield* Config.String("HOME")}/.codecommit/web.json`)
        expect(new WebControl.WebNotRunning().message).toBe(
          "CodeCommit web is not running. Start it with codecommit web; it prints a link."
        )
        expect(yield* Effect.flip(WebControl.requestLoginUrl)).toBeInstanceOf(WebControl.WebNotRunning)
        yield* WebControl.writeControlFile({ origin: "http://127.0.0.1:3001", token: "a1".repeat(32) })
        const refused = yield* Effect.flip(WebControl.requestLoginUrl)
        expect(refused).toBeInstanceOf(WebControl.WebLoginRefused)
        expect(refused.message).toBe(
          "CodeCommit web refused the sign-in request (HTTP 401). Restart it for a new link."
        )
      }))
  )
})

// Configuration failures retain the existing product error channels rather than leaking ConfigError.
it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    ConfigProvider.layer(ConfigProvider.fromUnknown({})),
    Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die("Missing home must not send a request")))
  )
)((it) => {
  it.effect("classifies an unavailable home as not running or failed publication", () =>
    Effect.gen(function*() {
      expect(yield* Effect.flip(WebControl.requestLoginUrl)).toBeInstanceOf(WebControl.WebNotRunning)
      expect(
        yield* Effect.flip(WebControl.writeControlFile({ origin: "http://127.0.0.1:3001", token: "a1".repeat(32) }))
      ).toBeInstanceOf(WebControl.ControlFileError)
    }))
})
