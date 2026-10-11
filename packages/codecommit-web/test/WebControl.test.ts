import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Config, ConfigProvider, Context, Effect, FileSystem, Layer, Logger } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as CodeHost from "../src/server/host.js"
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

class Home extends Context.Service<Home, { readonly path: string }>()("CodeCommitWeb/test/Home") {}
const originFixture = Layer.unwrap(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* fs.makeTempDirectoryScoped({ prefix: "cc-control-" })
  return Layer.mergeAll(
    Layer.succeed(Home, { path }),
    Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die("No control request expected"))),
    ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: path }))
  )
})).pipe(Layer.provideMerge(NodeServices.layer))
const control = { origin: "http://127.0.0.1:3001", token: "a1".repeat(32) }

describe("Code owner origin projection", () => {
  it.layer(Layer.fresh(originFixture))((it) =>
    it.effect("projects only the current bound owner origin without requesting a sign-in link", () =>
      Effect.gen(function*() {
        yield* WebControl.writeControlFile({ ...control, origin: "http://127.0.0.1:4780" })
        expect(yield* CodeHost.readCodeOwnerUi).toBe("http://127.0.0.1:4780")
        yield* WebControl.writeControlFile({ ...control, origin: "http://127.0.0.1:4781" })
        expect(yield* CodeHost.readCodeOwnerUi).toBe("http://127.0.0.1:4781")
      }))
  )

  it.layer(Layer.fresh(originFixture))((it) =>
    it.effect("rejects unsafe origin projections without exposing the control credential in failures or logs", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const file = yield* WebControl.controlFilePath
        const messages: Array<unknown> = []
        const logger = Logger.make<unknown, void>((entry) => messages.push(entry.message))
        yield* WebControl.writeControlFile(control)
        for (const origin of ["http://127.0.0.1:4780", "http://localhost:4780", "http://[::1]:4780"]) {
          yield* fs.writeFileString(file, JSON.stringify({ origin, token: control.token }))
          expect(yield* CodeHost.readCodeOwnerUi).toBe(origin)
        }
        for (
          const body of [
            ...[
              "https://127.0.0.1:4780",
              "http://user:pass@127.0.0.1:4780",
              "http://127.0.0.1:4780/x",
              "http://127.0.0.1:4780?q",
              "http://127.0.0.1:4780#f",
              "http://127.0.0.1:4780/",
              "http://example.com:4780",
              "http://127.0.0.1:65536"
            ].map((origin) => JSON.stringify({ origin, token: control.token })),
            `{"token":"${control.token}",`
          ]
        ) {
          yield* fs.writeFileString(file, body)
          const failure = yield* Effect.flip(CodeHost.readCodeOwnerUi).pipe(
            Effect.provideService(Logger.CurrentLoggers, new Set([logger]))
          )
          expect(failure._tag).toBe("WebNotRunning")
          expect(JSON.stringify(failure)).not.toContain(control.token)
        }
        expect(JSON.stringify(messages)).not.toContain(control.token)
      }))
  )

  it.layer(Layer.fresh(originFixture))((it) =>
    it.effect("refuses missing and permissive origin files without creating or repairing them", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const home = yield* Home
        const file = yield* WebControl.controlFilePath
        expect((yield* Effect.flip(CodeHost.readCodeOwnerUi))._tag).toBe("WebNotRunning")
        expect(yield* fs.exists(`${home.path}/.codecommit`)).toBe(false)
        yield* WebControl.writeControlFile(control)
        yield* fs.chmod(file, 0o644)
        expect((yield* Effect.flip(CodeHost.readCodeOwnerUi))._tag).toBe("WebNotRunning")
        expect((yield* fs.stat(file)).mode & 0o777).toBe(0o644)
        yield* fs.chmod(file, 0o600)
        yield* fs.chmod(`${home.path}/.codecommit`, 0o755)
        expect((yield* Effect.flip(CodeHost.readCodeOwnerUi))._tag).toBe("WebNotRunning")
        expect((yield* fs.stat(`${home.path}/.codecommit`)).mode & 0o777).toBe(0o755)
      }))
  )

  it.layer(Layer.fresh(originFixture))((it) =>
    it.effect("refuses a linked control file without reading or replacing its target", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const home = yield* Home
        yield* fs.makeDirectory(`${home.path}/.codecommit`, { mode: 0o700 })
        const target = `${home.path}/outside.json`
        yield* fs.writeFileString(target, "untouched")
        const file = yield* WebControl.controlFilePath
        yield* fs.symlink(target, file)
        expect((yield* Effect.flip(WebControl.writeControlFile(control)))._tag).toBe("ControlFileError")
        expect((yield* Effect.flip(WebControl.requestLoginUrl))._tag).toBe("WebNotRunning")
        expect((yield* Effect.flip(CodeHost.readCodeOwnerUi))._tag).toBe("WebNotRunning")
        expect(yield* fs.readFileString(target)).toBe("untouched")
        expect(yield* fs.readLink(file)).toBe(target)
      }))
  )
})
