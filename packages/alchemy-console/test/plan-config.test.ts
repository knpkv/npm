import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpClient } from "effect/http"
import { configuredPlanLayer, PlanReader } from "../src/server/PlanReader.js"

const fixtures = configuredPlanLayer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die("unexpected GitHub request")))),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))
)
layer(fixtures)("CI plan configuration", (it) => {
  it.effect("missing server token is Not connected and performs no GitHub request", () =>
    Effect.gen(function*() {
      const reader = yield* PlanReader
      expect(yield* reader.read("site", "prod")).toEqual({ _tag: "NotConnected" })
    }))
})
