import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { browserLaunch, BrowserOpener } from "@knpkv/browser-pairing/launch"
import {
  Context,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Queue,
  Ref,
  Sink,
  Stdio,
  Stream
} from "effect"
import { HttpClient } from "effect/http"
import { Catalog } from "../src/server/Catalog.js"
import { requestLoginUrl } from "../src/server/ControlSocket.js"
import { runConsole } from "../src/server/Launch.js"
import { disconnectedLayer } from "../src/server/PlanReader.js"
import { fixtureSourceLayer } from "./catalogFixture.js"

class LaunchFixture extends Context.Service<LaunchFixture, {
  readonly announced: Queue.Queue<string>
  readonly opened: Queue.Queue<string>
  readonly output: Ref.Ref<ReadonlyArray<string>>
}>()("AlchemyConsole/LaunchFixture") {}

const launchLayer = Layer.effectContext(Effect.gen(function*() {
  const announced = yield* Queue.unbounded<string>()
  const opened = yield* Queue.unbounded<string>()
  const output = yield* Ref.make<ReadonlyArray<string>>([])
  const stdio = Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.empty,
    stderr: () => Sink.drain,
    stdout: () =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Effect.gen(function*() {
          const line = Predicate.isString(chunk) ? chunk : new TextDecoder().decode(chunk)
          yield* Ref.update(output, (lines) => [...lines, line])
          if (line.startsWith("http://")) yield* Queue.offer(announced, line.trim())
        })
      )
  })
  return Context.make(LaunchFixture, { announced, opened, output }).pipe(
    Context.add(Stdio.Stdio, stdio),
    Context.add(BrowserOpener, {
      open: (url) => Queue.offer(opened, url).pipe(Effect.asVoid)
    })
  )
}))

const fixtures = Catalog.layer.pipe(
  Layer.provideMerge(fixtureSourceLayer),
  // Merge the capture last so live Node stdout cannot replace it in the retained platform context.
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp, launchLayer, disconnectedLayer))
)

const optionsFor = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-login-" })
  yield* fs.chmod(directory, 0o700)
  return { directory, port: 0, uid: Option.getOrElse((yield* fs.stat(directory)).uid, () => -1) }
})

layer(fixtures)("console launch lifecycle", (it) => {
  it.effect("starts in the foreground, opens a one-use login URL, and leaves a reused server running", () =>
    Effect.gen(function*() {
      const fixture = yield* LaunchFixture
      const client = yield* HttpClient.HttpClient
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const options = yield* optionsFor
      const running = yield* runConsole(options, { _tag: "Open" }, false).pipe(Effect.forkScoped)
      const url = yield* Queue.take(fixture.announced)
      expect(yield* Queue.take(fixture.opened)).toBe(url)
      const address = new URL(url)
      const live = { ...options, port: Number(address.port) }
      const token = new URLSearchParams(address.hash.slice(1)).get("bootstrap_token")
      const headers = { authorization: `Bearer ${token}`, origin: address.origin }
      expect((yield* client.post(`${address.origin}/auth/bootstrap`, { headers })).status).toBe(200)
      expect((yield* client.post(`${address.origin}/auth/bootstrap`, { headers })).status).toBe(401)
      yield* runConsole(live, { _tag: "Open" }, false)
      const reused = yield* Queue.take(fixture.announced)
      expect(yield* Queue.take(fixture.opened)).toBe(reused)
      expect(reused).not.toBe(url)
      expect((yield* client.get(`${address.origin}/`)).status).toBe(200)
      expect(Option.isSome(yield* requestLoginUrl(live))).toBe(true)
      yield* Fiber.interrupt(running)
      expect(yield* fs.exists(path.join(options.directory, `serve-${live.port}.sock`))).toBe(false)
      expect(Option.isNone(yield* requestLoginUrl(live))).toBe(true)
    }).pipe(Effect.scoped))

  it.effect("--no-open prints the ready URL and serves until interruption; serve prints only", () =>
    Effect.gen(function*() {
      const fixture = yield* LaunchFixture
      for (const printOnly of [false, true]) {
        const options = yield* optionsFor
        const launch = browserLaunch({ noOpen: true, browser: undefined, ci: undefined, interactive: true })
        const before = (yield* Ref.get(fixture.output)).length
        const running = yield* runConsole(options, launch, printOnly).pipe(Effect.forkScoped)
        const url = yield* Queue.take(fixture.announced)
        const client = yield* HttpClient.HttpClient
        expect((yield* client.get(new URL(url).origin + "/")).status).toBe(200)
        expect(yield* Queue.size(fixture.opened)).toBe(0)
        const lines = (yield* Ref.get(fixture.output)).slice(before)
        expect(lines[0]).toBe(`${url}\n`)
        if (printOnly) expect(lines).toHaveLength(1)
        yield* Fiber.interrupt(running)
      }
    }).pipe(Effect.scoped))

  it.effect("an unsafe control path fails without opening a browser or starting another server", () =>
    Effect.gen(function*() {
      const fixture = yield* LaunchFixture
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const options = yield* optionsFor
      const marker = path.join(options.directory, "serve-0.sock")
      yield* fs.writeFileString(marker, "fixture-private-sentinel")
      const before = (yield* Ref.get(fixture.output)).length
      expect(yield* Effect.flip(runConsole(options, { _tag: "Open" }, false))).toMatchObject({
        _tag: "ControlError",
        reason: "unsafe"
      })
      expect(yield* fs.readFileString(marker)).toBe("fixture-private-sentinel")
      expect((yield* Ref.get(fixture.output)).length).toBe(before)
      expect(yield* Queue.size(fixture.opened)).toBe(0)
    }).pipe(Effect.scoped))
})
