import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { ConfigProvider, Effect, Layer, Result, Schema } from "effect"
import { makeCodeModule, readCodeHost } from "../src/code-module.js"
import { codeModule } from "../src/module-contract.js"
import { dispatchModuleRoute, makeModuleLayer } from "../src/module-server.js"

const host = Schema.decodeUnknownSync(FleetHostName)("atlas")
const other = Schema.decodeUnknownSync(FleetHostName)("cedar")
const request = (listener: "serve" | "approval" | "tailnet" | "lan" | "work", search = "", method = "GET") =>
  dispatchModuleRoute({
    method,
    listener,
    url: new URL(`https://hub.example/v1/modules/code/queue${search}`),
    authorize: Effect.succeed({ login: "example-viewer" }),
    sameOrigin: Effect.void,
    readJson: () => Effect.die("Code has no write routes")
  })

const withModule = <A, E, R>(codeHost: FleetHostName | null, run: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const context = yield* Layer.build(
      makeModuleLayer([codeModule], [makeCodeModule({
        host,
        codeHost,
        isHub: true,
        stateDirectory: "/fixture/never-opened"
      })]).pipe(Layer.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)))
    )
    return yield* run.pipe(Effect.provideContext(context))
  })

describe("host-local Code module", () => {
  it.effect("requires explicit configuration and reports another credential host without opening its cache", () =>
    Effect.gen(function*() {
      expect((yield* withModule(null, request("serve")))?.body).toEqual({
        _tag: "Unavailable",
        reason: "not_configured",
        host: null
      })
      expect((yield* withModule(other, request("serve")))?.body).toEqual({
        _tag: "Unavailable",
        reason: "other_host",
        host: other
      })
    }))

  it.effect("serves no Code content or write route on peer and work listeners", () =>
    withModule(
      other,
      Effect.gen(function*() {
        for (
          const listener of ["approval", "tailnet", "lan", "work"] satisfies Array<
            "approval" | "tailnet" | "lan" | "work"
          >
        ) {
          expect(yield* request(listener)).toBeNull()
        }
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(yield* request("serve", "", method)).toBeNull()
      })
    ))

  it.effect("strictly refuses extra queue selectors even when unavailable", () =>
    withModule(
      other,
      Effect.gen(function*() {
        const outcome = yield* Effect.result(request("serve", "?profile=spoofed"))
        expect(Result.isFailure(outcome)).toBe(true)
        if (Result.isFailure(outcome)) expect(outcome.failure).toMatchObject({ status: 400, code: "invalid_query" })
      })
    ))

  it.effect("fails startup on an invalid configured host rather than auto-detecting", () =>
    Effect.gen(function*() {
      const absent = yield* readCodeHost.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))
      )
      expect(absent).toBeNull()
      const valid = yield* readCodeHost.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ RELAY_CODE_HOST: "atlas" }))
      )
      expect(valid).toBe(host)
      const invalid = yield* Effect.result(
        readCodeHost.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ RELAY_CODE_HOST: "invalid host" })
          )
        )
      )
      expect(Result.isFailure(invalid)).toBe(true)
      if (Result.isFailure(invalid)) expect(invalid.failure._tag).toBe("FleetValidationError")
    }))
})
