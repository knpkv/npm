import { assert, describe, it } from "@effect/vitest"
import { BrowserOpener } from "@knpkv/browser-pairing/launch"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Sink, Stdio } from "effect"
import { openControlCenter } from "../../src/server/ControlCenterOpen.js"
import { decodeBindConfig } from "../../src/server/security/BindConfig.js"

const url = `http://127.0.0.1:4173/#bootstrap_token=${"a".repeat(64)}`
const makeHarness = Effect.gen(function*() {
  const printed = yield* Ref.make<ReadonlyArray<string | Uint8Array>>([])
  const opened = yield* Ref.make<ReadonlyArray<string>>([])
  const serving = yield* Deferred.make<void>()
  const stopped = yield* Ref.make(false)
  const bindConfig = yield* decodeBindConfig({})
  return {
    printed,
    opened,
    serving,
    stopped,
    bindConfig,
    layer: Layer.mergeAll(
      Stdio.layerTest({
        stdout: () => Sink.forEach((chunk: string | Uint8Array) => Ref.update(printed, (chunks) => [...chunks, chunk]))
      }),
      Layer.succeed(BrowserOpener, { open: (link) => Ref.update(opened, (links) => [...links, link]) })
    )
  }
})
class Harness extends Context.Service<Harness, Effect.Success<typeof makeHarness>>()("ControlCenter/test/Open") {}
const fixture = Layer.unwrap(Effect.gen(function*() {
  const harness = yield* makeHarness
  return harness.layer.pipe(Layer.merge(Layer.succeed(Harness, harness)))
}))

describe("Control Center root invocation", () => {
  it.layer(Layer.fresh(fixture))((it) => {
    it.effect("reuses a running server, prints/opens and exits without calling serve", () =>
      Effect.gen(function*() {
        const h = yield* Harness
        yield* openControlCenter({
          bindConfig: h.bindConfig,
          launch: { _tag: "Open" },
          login: Effect.succeed(Option.some(url)),
          serve: () => Effect.die("must not touch a reused server")
        })
        assert.deepStrictEqual(yield* Ref.get(h.printed), [`${url}\n`])
        assert.deepStrictEqual(yield* Ref.get(h.opened), [url])
        assert.isFalse(yield* Ref.get(h.stopped))
      }))
  })
  it.layer(Layer.fresh(fixture))((it) => {
    it.effect("keeps a newly started foreground server alive until interruption releases its scope", () =>
      Effect.gen(function*() {
        const h = yield* Harness
        const fiber = yield* openControlCenter({
          bindConfig: h.bindConfig,
          launch: { _tag: "Open" },
          login: Effect.succeed(Option.none()),
          serve: (onReady) =>
            Effect.gen(function*() {
              yield* Effect.acquireRelease(Effect.void, () => Ref.set(h.stopped, true))
              yield* onReady(url)
              yield* Deferred.succeed(h.serving, undefined)
              return yield* Effect.never
            })
        }).pipe(Effect.forkScoped)
        yield* Deferred.await(h.serving)
        assert.isUndefined(fiber.pollUnsafe())
        assert.isFalse(yield* Ref.get(h.stopped))
        yield* Fiber.interrupt(fiber)
        assert.isTrue(yield* Ref.get(h.stopped))
        assert.deepStrictEqual(yield* Ref.get(h.opened), [url])
      }))
  })
  it.layer(Layer.fresh(fixture))((it) => {
    it.effect("no-open prints the link without invoking the opener", () =>
      Effect.gen(function*() {
        const h = yield* Harness
        yield* openControlCenter({
          bindConfig: h.bindConfig,
          launch: { _tag: "Skip", reason: "--no-open" },
          login: Effect.succeed(Option.some(url)),
          serve: () => Effect.die("unexpected serve")
        })
        assert.deepStrictEqual(yield* Ref.get(h.opened), [])
        assert.include((yield* Ref.get(h.printed)).join(""), url)
      }))
  })
  it.layer(Layer.fresh(fixture))((it) => {
    it.effect("TLS, proxy and insecure LAN modes print guidance without probing, minting, opening or serving", () =>
      Effect.gen(function*() {
        const h = yield* Harness
        for (
          const bindConfig of [
            yield* decodeBindConfig({
              directTls: {
                certificateRef: `secret_${"a".repeat(64)}`,
                privateKeyRef: `secret_${"b".repeat(64)}`
              }
            }),
            yield* decodeBindConfig({
              host: "127.0.0.1",
              publicOrigin: "https://control.example.com",
              trustedProxyAddresses: ["127.0.0.1"]
            }),
            yield* decodeBindConfig({
              host: "0.0.0.0",
              port: 4173,
              publicOrigin: "http://192.168.1.2:4173",
              allowedHosts: ["192.168.1.2:4173"],
              allowedOrigins: ["http://192.168.1.2:4173"],
              allowInsecureLan: true
            })
          ]
        ) {
          yield* openControlCenter({
            bindConfig,
            launch: { _tag: "Open" },
            login: Effect.die("unexpected mint"),
            serve: () => Effect.die("unexpected serve")
          })
        }
        assert.deepStrictEqual(yield* Ref.get(h.printed), [
          "sign in through https://127.0.0.1:4173\n",
          "sign in through https://control.example.com\n",
          "sign in through http://192.168.1.2:4173\n"
        ])
        assert.deepStrictEqual(yield* Ref.get(h.opened), [])
      }))
  })
})
