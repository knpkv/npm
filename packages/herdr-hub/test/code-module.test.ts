import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { ConfigProvider, Effect, FileSystem, Layer, Logger, Result, Schema } from "effect"
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

const reviewRequest = (listener: "serve" | "approval" | "tailnet" | "lan" | "work", method = "GET", extra = "") =>
  dispatchModuleRoute({
    method,
    listener,
    url: new URL(`https://hub.example/v1/modules/code/review?ref=00000000-0000-4000-8000-000000000001${extra}`),
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
  it.effect("review is an authenticated same-host GET with no peer or command route", () =>
    withModule(
      other,
      Effect.gen(function*() {
        expect((yield* reviewRequest("serve"))?.body).toEqual({
          _tag: "Unavailable",
          reason: "other_host",
          host: other
        })
        for (
          const listener of ["approval", "tailnet", "lan", "work"] satisfies ReadonlyArray<
            "approval" | "tailnet" | "lan" | "work"
          >
        ) {
          expect(yield* reviewRequest(listener)).toBeNull()
        }
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
          expect(yield* reviewRequest("serve", method)).toBeNull()
        }
        const invalid = yield* Effect.result(reviewRequest("serve", "GET", "&profile=spoofed"))
        expect(invalid._tag).toBe("Failure")
        if (invalid._tag === "Failure") expect(invalid.failure).toMatchObject({ status: 400, code: "invalid_query" })
      })
    ))

  it.layer(NodeServices.layer)((it) =>
    it.effect("includes only the current private owner origin even when the credential host cache is unavailable", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "code-hub-owner-" })
        const directory = `${home}/.codecommit`
        const file = `${directory}/web.json`
        const token = "d4".repeat(32)
        yield* fs.makeDirectory(directory, { mode: 0o700 })
        yield* fs.writeFileString(file, JSON.stringify({ origin: "http://127.0.0.1:4780", token }), { mode: 0o600 })
        const messages: Array<unknown> = []
        const logger = Logger.make<unknown, void>((entry) => messages.push(entry.message))
        yield* withModule(
          host,
          Effect.gen(function*() {
            const first = yield* request("serve")
            expect(first?.body).toEqual({
              _tag: "Unavailable",
              reason: "cache_unavailable",
              host,
              ownerUi: "http://127.0.0.1:4780"
            })
            yield* fs.writeFileString(file, JSON.stringify({ origin: "http://127.0.0.1:4781", token }))
            expect((yield* request("serve"))?.body).toMatchObject({ ownerUi: "http://127.0.0.1:4781" })
            expect(JSON.stringify(first?.body)).not.toContain(token)
            yield* fs.chmod(file, 0o644)
            expect((yield* request("serve"))?.body).not.toHaveProperty("ownerUi")
            yield* fs.chmod(file, 0o600)
            yield* fs.writeFileString(file, `{"token":"${token}",`)
            expect((yield* request("serve"))?.body).not.toHaveProperty("ownerUi")
          })
        ).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ HOME: home })),
          Effect.withLogger(logger)
        )
        expect(JSON.stringify(messages)).not.toContain(token)
      }))
  )

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
