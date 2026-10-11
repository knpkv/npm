import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { BrowserOpener, skippedLine } from "@knpkv/browser-pairing/launch"
import { HomeDirectory, WebControl } from "@knpkv/jira-clockify"
import {
  ConfigProvider,
  Console,
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Ref,
  Runtime,
  Sink
} from "effect"
import { Command } from "effect/cli"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import * as Stdio from "effect/Stdio"
import { announceWeekView, makeCommand, type WeekViewServe } from "../src/Command.js"

const origin = "http://127.0.0.1:3111"
const url = `${origin}/#bootstrap_token=${"a".repeat(64)}`
const control = { origin, token: "c0".repeat(32) }

/** Isolate the home/control file and capture output, HTTP requests and browser launches. */
const makeHarness = Effect.fn("JcfWeb.test.makeHarness")(
  function*(environment: Readonly<Record<string, string>>, interactive: boolean) {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "jcf-launch-" })
    const stdout = yield* Ref.make<ReadonlyArray<string | Uint8Array>>([])
    const opened = yield* Ref.make<ReadonlyArray<string>>([])
    const requests = yield* Ref.make<ReadonlyArray<string>>([])
    const mode = yield* Ref.make<"running" | "stopped" | "refused">("running")
    const originalConsole = yield* Console.Console
    const errors: Array<unknown> = []
    const printed: Array<unknown> = []
    const client = HttpClient.make((request) =>
      Effect.gen(function*() {
        yield* Ref.update(requests, (values) => [...values, `${request.method} ${request.url}`])
        expect(request.headers.authorization).toBe(`Bearer ${control.token}`)
        const current = yield* Ref.get(mode)
        if (current === "stopped") {
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "connection refused" })
          })
        }
        return HttpClientResponse.fromWeb(
          request,
          current === "refused"
            ? new Response(null, { status: 401 })
            : Response.json({ url })
        )
      })
    )
    return {
      stdout,
      opened,
      requests,
      mode,
      errors,
      printed,
      layer: Layer.mergeAll(
        Layer.succeed(HomeDirectory.HomeDirectory, HomeDirectory.HomeDirectory.of({ path: home })),
        Layer.succeed(HttpClient.HttpClient, client),
        ConfigProvider.layer(ConfigProvider.fromUnknown(environment)),
        Stdio.layerTest({
          stdoutIsTerminal: Effect.succeed(interactive),
          stdout: () => Sink.forEach((chunk: string | Uint8Array) => Ref.update(stdout, (chunks) => [...chunks, chunk]))
        }),
        Layer.succeed(Console.Console, {
          ...originalConsole,
          log: (...values: ReadonlyArray<unknown>) => {
            for (const value of values) printed.push(value)
          },
          error: (...values: ReadonlyArray<unknown>) => {
            for (const value of values) errors.push(value)
          }
        }),
        Layer.succeed(
          BrowserOpener,
          BrowserOpener.of({ open: (value) => Ref.update(opened, (values) => [...values, value]) })
        )
      )
    }
  }
)

class Harness extends Context.Service<Harness, Effect.Success<ReturnType<typeof makeHarness>>>()(
  "@knpkv/jcf-web/test/LaunchHarness"
) {}
const makeTestLayer = (environment: Readonly<Record<string, string>> = {}, interactive = true) =>
  Layer.unwrap(Effect.map(makeHarness(environment, interactive), (harness) =>
    Layer.mergeAll(
      Layer.succeed(Harness, harness),
      harness.layer
    ))).pipe(Layer.provideMerge(NodeServices.layer))
const output = (chunks: ReadonlyArray<string | Uint8Array>): string =>
  chunks.map((chunk) => Predicate.isString(chunk) ? chunk : new TextDecoder().decode(chunk)).join("")

/** Run the real command parser with an injected foreground listener. */
const run = <E, R>(args: ReadonlyArray<string>, serve: WeekViewServe<E, R>) =>
  Command.runWith(makeCommand(serve), { version: "test" })(args).pipe(Effect.scoped)

const unexpectedServe: WeekViewServe<never, never> = () => Effect.die("must not start a server")

describe("jcf-web launch", () => {
  it.layer(makeTestLayer({ PORT: "not-a-port" }))((it) => {
    it.effect("reuses the running week view, prints a bare link and opens it without starting", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        yield* WebControl.writeControlFile(control)
        yield* run(["--port", "1"], unexpectedServe)
        expect(output(yield* Ref.get(harness.stdout))).toBe(`${url}\n`)
        expect(yield* Ref.get(harness.opened)).toEqual([url])
        expect(yield* Ref.get(harness.requests)).toEqual([`POST ${origin}/control/login`])
        expect(harness.errors).toEqual([])
        const fs = yield* FileSystem.FileSystem
        expect(yield* fs.exists(yield* WebControl.controlFilePath)).toBe(true)
      }))
  })

  const skipCases: ReadonlyArray<readonly [Readonly<Record<string, string>>, boolean, string]> = [
    [{}, true, "--no-open"],
    [{ BROWSER: "none" }, true, "BROWSER=none"],
    [{ CI: "true" }, true, "CI is set"],
    [{}, false, "not an interactive terminal"]
  ]
  for (const [environment, interactive, reason] of skipCases) {
    it.layer(makeTestLayer(environment, interactive))((it) => {
      it.effect(`prints the reused link without opening for ${reason}`, () =>
        Effect.gen(function*() {
          const harness = yield* Harness
          yield* WebControl.writeControlFile(control)
          yield* run(reason === "--no-open" ? ["--no-open"] : [], unexpectedServe)
          expect(output(yield* Ref.get(harness.stdout))).toBe(`${url}\n${skippedLine(reason)}\n`)
          expect(yield* Ref.get(harness.opened)).toEqual([])
          expect(harness.errors).toEqual([])
        }))
    })
  }

  for (const prior of ["missing", "stale"]) {
    it.layer(makeTestLayer())((it) => {
      it.effect(`starts once for a ${prior} control file and releases its scope only on interruption`, () =>
        Effect.gen(function*() {
          const harness = yield* Harness
          const fs = yield* FileSystem.FileSystem
          if (prior === "stale") {
            yield* WebControl.writeControlFile(control)
            yield* Ref.set(harness.mode, "stopped")
          }
          const ready = yield* Deferred.make<void>()
          const released = yield* Ref.make(false)
          const calls = yield* Ref.make(0)
          const serverToken = "b0".repeat(32)
          const serve = (port: Option.Option<number>, announce: Parameters<WeekViewServe<never, never>>[1]) =>
            Effect.gen(function*() {
              expect(port).toEqual(Option.some(4321))
              yield* Ref.update(calls, (count) => count + 1)
              yield* Effect.addFinalizer(() => Ref.set(released, true))
              yield* announceWeekView(origin, serverToken, url, announce)
              yield* Deferred.succeed(ready, undefined)
              return yield* Effect.never
            })
          const fiber = yield* run(["--port", "4321", "--no-open"], serve).pipe(Effect.forkScoped)
          yield* Deferred.await(ready)
          expect(yield* Ref.get(calls)).toBe(1)
          expect(yield* Ref.get(released)).toBe(false)
          expect(output(yield* Ref.get(harness.stdout))).toBe(`${url}\n${skippedLine("--no-open")}\n`)
          expect(yield* Ref.get(harness.opened)).toEqual([])
          const file = yield* WebControl.controlFilePath
          expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600)
          expect(yield* fs.readFileString(file)).toContain(serverToken)
          yield* Fiber.interrupt(fiber)
          expect(yield* Ref.get(released)).toBe(true)
          expect(yield* fs.exists(file)).toBe(false)
        }))
    })
  }

  it.layer(makeTestLayer())((it) => {
    it.effect("refuses to start another server when the running one refuses login", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        yield* WebControl.writeControlFile(control)
        yield* Ref.set(harness.mode, "refused")
        const failure = yield* Effect.flip(run([], unexpectedServe))
        expect(failure._tag).toBe("Reported")
        if (failure._tag !== "Reported") return yield* Effect.die("Expected the reported login failure")
        expect(failure[Runtime.errorReported]).toBe(false)
        expect(harness.errors).toEqual([
          "jcf-web refused the sign-in request (HTTP 401). Restart jcf-web for a new link."
        ])
        expect(output(yield* Ref.get(harness.stdout))).toBe("")
        expect(yield* Ref.get(harness.opened)).toEqual([])
        expect(yield* Ref.get(harness.requests)).toEqual([`POST ${origin}/control/login`])
      }))
  })

  it.layer(makeTestLayer())((it) => {
    it.effect("serve keeps its prefixed print-only startup and never requests a login", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        const ready = yield* Deferred.make<void>()
        const serve = (port: Option.Option<number>, announce: Parameters<WeekViewServe<never, never>>[1]) =>
          Effect.gen(function*() {
            expect(port).toEqual(Option.none())
            yield* announceWeekView(origin, control.token, url, announce)
            yield* Deferred.succeed(ready, undefined)
            return yield* Effect.never
          })
        const fiber = yield* run(["serve"], serve).pipe(Effect.forkScoped)
        yield* Deferred.await(ready)
        expect(output(yield* Ref.get(harness.stdout))).toBe(`jcf week view: ${url}\n`)
        expect(yield* Ref.get(harness.opened)).toEqual([])
        expect(yield* Ref.get(harness.requests)).toEqual([])
        yield* Fiber.interrupt(fiber)
        const fs = yield* FileSystem.FileSystem
        expect(yield* fs.exists(yield* WebControl.controlFilePath)).toBe(false)
      }))
  })

  it.layer(makeTestLayer())((it) => {
    it.effect("login keeps its prefixed print-only fresh link without starting or opening", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        yield* WebControl.writeControlFile(control)
        yield* run(["login"], unexpectedServe)
        expect(harness.printed).toEqual([`jcf week view: ${url}`])
        expect(output(yield* Ref.get(harness.stdout))).toBe("")
        expect(yield* Ref.get(harness.opened)).toEqual([])
        expect(yield* Ref.get(harness.requests)).toEqual([`POST ${origin}/control/login`])
      }))
  })
})
