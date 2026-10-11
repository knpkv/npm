import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { browserLaunch, BrowserOpener, BrowserOpenError, openOrServe, skippedLine } from "@knpkv/browser-pairing/launch"
import {
  Console,
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Predicate,
  Ref,
  Sink
} from "effect"
import * as Stdio from "effect/Stdio"
import { createServer, type Server } from "node:net"
import { existingLoginUrl, login, LoginFailed } from "../src/server/Login.js"

const url = `http://127.0.0.1:3112/#bootstrap_token=${"a".repeat(64)}`
const terminal = { noOpen: false, browser: undefined, ci: undefined, interactive: true }

/** Capture each output boundary and replace browser launching with an observation. */
const makeHarness = Effect.gen(function*() {
  const stdout = yield* Ref.make<ReadonlyArray<string | Uint8Array>>([])
  const opened = yield* Ref.make<ReadonlyArray<string>>([])
  const printed: Array<unknown> = []
  const stderr: Array<unknown> = []
  const order: Array<string> = []
  const originalConsole = yield* Console.Console
  return {
    stdout,
    opened,
    printed,
    stderr,
    order,
    layer: Layer.mergeAll(
      Stdio.layerTest({
        stdout: () => Sink.forEach((chunk: string | Uint8Array) => Ref.update(stdout, (chunks) => [...chunks, chunk]))
      }),
      Layer.succeed(Console.Console, {
        ...originalConsole,
        log: (...values: ReadonlyArray<unknown>) => {
          for (const value of values) printed.push(value)
          order.push("print")
        },
        error: (...values: ReadonlyArray<unknown>) => {
          for (const value of values) stderr.push(value)
        }
      }),
      Layer.succeed(
        BrowserOpener,
        BrowserOpener.of({
          open: (value) =>
            Ref.update(opened, (values) => [...values, value]).pipe(
              Effect.tap(() => Effect.sync(() => order.push("open")))
            )
        })
      ),
      Layer.succeed(Logger.LogToStderr, true),
      Logger.layer([Logger.defaultLogger])
    )
  }
})

class Harness extends Context.Service<Harness, Effect.Success<typeof makeHarness>>()(
  "@knpkv/agent-usage/test/LaunchHarness"
) {}

const harnessLayer = Layer.unwrap(
  Effect.map(makeHarness, (harness) => Layer.mergeAll(Layer.succeed(Harness, harness), harness.layer))
)
const testLayer = Layer.mergeAll(NodeServices.layer, harnessLayer)

/** A short owner-only store path, within the Unix socket limit on every supported host. */
const store = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "au-launch-" })
  yield* fs.chmod(directory, 0o700)
  const info = yield* fs.stat(directory)
  return { directory, self: Option.getOrElse(info.uid, () => -1) }
})

/** A running server stand-in: answer mint without starting an HTTP listener or touching a store. */
const mintServer = (socketPath: string, requests: Array<string>, reply = `{"url":"${url}"}\n`) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      new Promise<Server>((resolve) => {
        const server = createServer((connection) => {
          connection.on("data", (chunk) => {
            requests.push(chunk.toString())
            connection.end(reply)
          })
        })
        server.listen(socketPath, () => resolve(server))
      })
    ),
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
  )

const output = (chunks: ReadonlyArray<string | Uint8Array>): string =>
  chunks.map((chunk) => Predicate.isString(chunk) ? chunk : new TextDecoder().decode(chunk)).join("")

describe("agent-usage without a subcommand", () => {
  it.layer(testLayer)((it) => {
    it.effect("reuses a running server with one mint request, opens its URL and returns without serving", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        const path = yield* Path.Path
        const { directory, self } = yield* store
        const requests: Array<string> = []
        yield* mintServer(path.join(directory, "serve.sock"), requests)
        const served = yield* Ref.make(0)
        yield* openOrServe({
          login: existingLoginUrl(Effect.succeed({ storeDirectory: directory }), self),
          serve: () => Ref.update(served, (count) => count + 1).pipe(Effect.andThen(Effect.never)),
          launch: browserLaunch(terminal)
        })
        expect(requests).toEqual(["mint\n"])
        expect(yield* Ref.get(served)).toBe(0)
        expect(output(yield* Ref.get(harness.stdout))).toBe(`${url}\n`)
        expect(yield* Ref.get(harness.opened)).toEqual([url])
        expect(harness.stderr).toEqual([])
        expect(harness.printed).toEqual([])
      }))
  })

  it.layer(testLayer)((it) => {
    it.effect("prints the URL and skip reason without invoking the opener", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        const path = yield* Path.Path
        const { directory, self } = yield* store
        yield* mintServer(path.join(directory, "serve.sock"), [])
        yield* openOrServe({
          login: existingLoginUrl(Effect.succeed({ storeDirectory: directory }), self),
          serve: () => Effect.die("a running server must not be started again"),
          launch: browserLaunch({ ...terminal, noOpen: true })
        })
        expect(output(yield* Ref.get(harness.stdout))).toBe(`${url}\n${skippedLine("--no-open")}\n`)
        expect(yield* Ref.get(harness.opened)).toEqual([])
      }))
  })

  it.layer(testLayer)((it) => {
    it.effect("starts only when no server runs, announces once and releases the foreground scope on interruption", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        const { directory, self } = yield* store
        const ready = yield* Deferred.make<void>()
        const served = yield* Ref.make(0)
        const released = yield* Ref.make(false)
        const fiber = yield* openOrServe({
          login: existingLoginUrl(Effect.succeed({ storeDirectory: directory }), self),
          serve: (onReady) =>
            Effect.gen(function*() {
              yield* Effect.addFinalizer(() => Ref.set(released, true))
              yield* Ref.update(served, (count) => count + 1)
              yield* onReady(url)
              yield* Deferred.succeed(ready, undefined)
              return yield* Effect.never
            }),
          launch: browserLaunch(terminal)
        }).pipe(Effect.forkChild)
        yield* Deferred.await(ready)
        expect(fiber.pollUnsafe()).toBeUndefined()
        expect(yield* Ref.get(served)).toBe(1)
        expect(yield* Ref.get(released)).toBe(false)
        expect(output(yield* Ref.get(harness.stdout))).toBe(`${url}\n`)
        expect(yield* Ref.get(harness.opened)).toEqual([url])
        yield* Fiber.interrupt(fiber)
        expect(yield* Ref.get(released)).toBe(true)
      }))
  })

  it.layer(testLayer)((it) => {
    it.effect("refuses an unsafe socket, reports only on stderr and never serves", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const { directory, self } = yield* store
        const socketPath = path.join(directory, "serve.sock")
        yield* fs.writeFileString(socketPath, "not a socket")
        const served = yield* Ref.make(0)
        const failure = yield* Effect.flip(openOrServe({
          login: existingLoginUrl(Effect.succeed({ storeDirectory: directory }), self),
          serve: () => Ref.update(served, (count) => count + 1).pipe(Effect.andThen(Effect.never)),
          launch: browserLaunch(terminal)
        }))
        expect(failure).toBeInstanceOf(LoginFailed)
        expect(failure).toMatchObject({ reason: "SocketPathUnsafe" })
        expect(harness.stderr).toEqual([
          `agent-usage: agent-usage refused its control socket at ${socketPath}: it is a File, not a socket. Remove it and restart the server.`
        ])
        expect(output(yield* Ref.get(harness.stdout))).toBe("")
        expect(harness.printed).toEqual([])
        expect(yield* Ref.get(harness.opened)).toEqual([])
        expect(yield* Ref.get(served)).toBe(0)
      }))
  })

  it.layer(testLayer)((it) => {
    it.effect("rejects an invalid reply without reporting the reply or starting a server", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        const path = yield* Path.Path
        const { directory, self } = yield* store
        yield* mintServer(path.join(directory, "serve.sock"), [], `{"url":"${url}invalid"}\n`)
        const failure = yield* Effect.flip(existingLoginUrl(Effect.succeed({ storeDirectory: directory }), self))
        expect(failure).toBeInstanceOf(LoginFailed)
        expect(failure).toMatchObject({ reason: "LoginReplyInvalid" })
        expect(harness.stderr).toEqual([
          "agent-usage: the running agent-usage did not answer with a link; is it an older version? Restart it."
        ])
        expect(harness.stderr.join(" ")).not.toContain(url)
        expect(output(yield* Ref.get(harness.stdout))).toBe("")
      }))
  })
})

describe("agent-usage login --open", () => {
  it.layer(testLayer)((it) => {
    it.effect("prints before calling the shared browser opener", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        const path = yield* Path.Path
        const { directory, self } = yield* store
        yield* mintServer(path.join(directory, "serve.sock"), [])
        yield* login(Effect.succeed({ storeDirectory: directory }), true, self)
        expect(harness.printed).toEqual([url])
        expect(harness.order).toEqual(["print", "open"])
        expect(yield* Ref.get(harness.opened)).toEqual([url])
        expect(harness.stderr).toEqual([])
      }))
  })

  it.layer(Layer.mergeAll(
    testLayer,
    Layer.succeed(
      BrowserOpener,
      BrowserOpener.of({
        open: () => Effect.fail(new BrowserOpenError({}))
      })
    )
  ))((it) => {
    it.effect("keeps the printed link on stdout and a failed opener's warning on stderr", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        const path = yield* Path.Path
        const { directory, self } = yield* store
        yield* mintServer(path.join(directory, "serve.sock"), [])
        yield* login(Effect.succeed({ storeDirectory: directory }), true, self)
        expect(harness.printed).toEqual([url])
        expect(harness.stderr).toContain("No browser could be opened; open the link above")
        expect(harness.stderr.join(" ")).not.toContain(url)
      }))
  })
})
