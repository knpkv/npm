import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { serveWithBootstrapUrl } from "@knpkv/browser-pairing/owner-session"
import { ConfigProvider, Context, Deferred, Effect, Fiber, FileSystem, Layer, Logger, Ref } from "effect"
import { HttpClient } from "effect/http"
import * as CodeHost from "../src/server/host.js"
import * as WebControl from "../src/server/internal/WebControl.js"

class Home extends Context.Service<Home, { readonly path: string }>()("CodeCommitWeb/test/Home") {}
const fixture = Layer.unwrap(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* fs.makeTempDirectoryScoped({ prefix: "cc-control-" })
  return Layer.mergeAll(
    Layer.succeed(Home, { path }),
    Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die("No control request expected"))),
    ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: path }))
  )
})).pipe(Layer.provideMerge(NodeServices.layer))
const control = { origin: "http://127.0.0.1:3001", token: "a1".repeat(32) }

describe("CodeCommit owner control file", () => {
  it.layer(Layer.fresh(fixture))((it) =>
    it.effect("projects only the current bound owner origin without requesting a sign-in link", () =>
      Effect.gen(function*() {
        yield* WebControl.writeControlFile({ ...control, origin: "http://127.0.0.1:4780" })
        expect(yield* CodeHost.readCodeOwnerUi).toBe("http://127.0.0.1:4780")
        yield* WebControl.writeControlFile({ ...control, origin: "http://127.0.0.1:4781" })
        expect(yield* CodeHost.readCodeOwnerUi).toBe("http://127.0.0.1:4781")
      }))
  )

  it.layer(Layer.fresh(fixture))((it) =>
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

  it.layer(Layer.fresh(fixture))((it) =>
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

  it.layer(Layer.fresh(fixture))((it) =>
    it.effect("publishes atomically with owner-only permissions and removes only its own token", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const home = yield* Home
        const file = yield* WebControl.controlFilePath
        yield* WebControl.writeControlFile(control)
        expect((yield* fs.stat(`${home.path}/.codecommit`)).mode & 0o777).toBe(0o700)
        expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600)
        expect(JSON.parse(yield* fs.readFileString(file))).toEqual(control)
        const next = { origin: "http://127.0.0.1:3002", token: "b2".repeat(32) }
        yield* WebControl.writeControlFile(next)
        yield* WebControl.removeControlFile(control.token)
        expect(JSON.parse(yield* fs.readFileString(file))).toEqual(next)
        yield* WebControl.removeControlFile(next.token)
        expect(yield* fs.exists(file)).toBe(false)
      }))
  )

  it.layer(Layer.fresh(fixture))((it) =>
    it.effect("refuses linked private directories without changing the target", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const home = yield* Home
        const target = yield* fs.makeTempDirectoryScoped({ prefix: "cc-target-" })
        const before = (yield* fs.stat(target)).mode
        yield* fs.symlink(target, `${home.path}/.codecommit`)
        const error = yield* Effect.flip(WebControl.writeControlFile(control))
        expect(error._tag).toBe("ControlFileError")
        expect((yield* fs.stat(target)).mode).toBe(before)
        expect(yield* fs.exists(`${target}/web.json`)).toBe(false)
      }))
  )

  it.layer(Layer.fresh(fixture))((it) =>
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

  it.layer(Layer.fresh(fixture))((it) =>
    it.effect("refuses a directory whose permissions expose the control token", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const home = yield* Home
        yield* fs.makeDirectory(`${home.path}/.codecommit`, { mode: 0o755 })
        yield* fs.chmod(`${home.path}/.codecommit`, 0o755)
        expect((yield* Effect.flip(WebControl.writeControlFile(control)))._tag).toBe("ControlFileError")
        expect((yield* fs.stat(`${home.path}/.codecommit`)).mode & 0o777).toBe(0o755)
      }))
  )
  it.layer(Layer.fresh(fixture))((it) =>
    it.effect("publishes only after listening, stays foreground and cleans up on interruption", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const file = yield* WebControl.controlFilePath
        const started = yield* Deferred.make<void>()
        const listening = yield* Deferred.make<void>()
        const announced = yield* Deferred.make<void>()
        const stopped = yield* Ref.make(false)
        const calls = yield* Ref.make(0)
        const url = `${control.origin}/#bootstrap_token=${"a".repeat(64)}`
        const serving = serveWithBootstrapUrl(
          (ready) =>
            Layer.effectDiscard(Effect.gen(function*() {
              yield* Effect.addFinalizer(() => Ref.set(stopped, true))
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(listening)
              yield* Deferred.succeed(ready, url)
            })),
          (link) =>
            Effect.gen(function*() {
              expect(link).toBe(url)
              yield* WebControl.registerControlFile(control)
              yield* Ref.update(calls, (count) => count + 1)
              yield* Deferred.succeed(announced, undefined)
            })
        )
        const running = yield* Effect.scoped(serving).pipe(Effect.forkScoped)
        yield* Deferred.await(started)
        expect(yield* fs.exists(file)).toBe(false)
        yield* Deferred.succeed(listening, undefined)
        yield* Deferred.await(announced)
        expect(yield* fs.exists(file)).toBe(true)
        expect(yield* Ref.get(calls)).toBe(1)
        expect(yield* Ref.get(stopped)).toBe(false)
        yield* Fiber.interrupt(running)
        expect(yield* Ref.get(stopped)).toBe(true)
        expect(yield* fs.exists(file)).toBe(false)
      }))
  )
})
