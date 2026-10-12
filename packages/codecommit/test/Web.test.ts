import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { BrowserOpener, skippedLine } from "@knpkv/browser-pairing/launch"
import {
  ConfigProvider,
  Console,
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Ref,
  Runtime,
  Sink
} from "effect"
import { Command } from "effect/cli"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import * as Stdio from "effect/Stdio"
import { makeWebCommand, type WebServe } from "../src/Web.js"

const origin = "http://127.0.0.1:3001"
const url = `${origin}/#bootstrap_token=${"a".repeat(64)}`
const control = { origin, token: "c0".repeat(32) }

/** Isolate the home/control file and capture output, HTTP requests and browser launches. */
const makeHarness = Effect.fn("CodeCommitWeb.test.makeHarness")(
  function*(environment: Readonly<Record<string, string>>, interactive: boolean) {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "cc-launch-" })
    const stdout = yield* Ref.make<ReadonlyArray<string | Uint8Array>>([])
    const opened = yield* Ref.make<ReadonlyArray<string>>([])
    const requests = yield* Ref.make<ReadonlyArray<string>>([])
    const mode = yield* Ref.make<"running" | "stopped" | "refused" | "malformed">("running")
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
            : Response.json({ url: current === "malformed" ? "https://example.com/" : url })
        )
      })
    )
    return {
      file: `${home}/.codecommit/web.json`,
      stdout,
      opened,
      requests,
      mode,
      errors,
      printed,
      layer: Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, client),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ ...environment, HOME: home })),
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
  "@knpkv/codecommit/test/LaunchHarness"
) {}
const makeTestLayer = (environment: Readonly<Record<string, string>> = {}, interactive = true) =>
  Layer.unwrap(Effect.map(makeHarness(environment, interactive), (harness) =>
    Layer.mergeAll(
      Layer.succeed(Harness, harness),
      harness.layer
    ))).pipe(Layer.provideMerge(NodeServices.layer))
const output = (chunks: ReadonlyArray<string | Uint8Array>): string =>
  chunks.map((chunk) => Predicate.isString(chunk) ? chunk : new TextDecoder().decode(chunk)).join("")

/** Fake only the owner-only filesystem boundary; the command uses the package's real login client. */
const writeControl = Effect.fn("WebCommandTest.writeControl")(
  function*(value: { readonly origin: string; readonly token: string }) {
    const harness = yield* Harness
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.dirname(harness.file), { mode: 0o700, recursive: true })
    yield* fs.writeFileString(harness.file, JSON.stringify(value), { mode: 0o600 })
  }
)

/** Run the real command parser with an injected foreground listener. */
const run = <E, R>(args: ReadonlyArray<string>, serve: WebServe<E, R>) =>
  Command.runWith(
    Command.make("codecommit", {}, () => Effect.die("TUI should not run")).pipe(
      Command.withSubcommands([makeWebCommand(serve)])
    ),
    { version: "test" }
  )(["web", ...args]).pipe(Effect.scoped)

const unexpectedServe: WebServe<never, never> = () => Effect.die("must not start a server")

describe("codecommit web launch", () => {
  it.layer(makeTestLayer({ PORT: "not-a-port" }))((it) => {
    it.effect("reuses the running server, prints a bare link and opens it without starting", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        yield* writeControl(control)
        yield* run(["--port", "1"], unexpectedServe)
        expect(output(yield* Ref.get(harness.stdout))).toBe(`${url}\n`)
        expect(yield* Ref.get(harness.opened)).toEqual([url])
        expect(yield* Ref.get(harness.requests)).toEqual([`POST ${origin}/control/login`])
        expect(harness.errors).toEqual([])
        const fs = yield* FileSystem.FileSystem
        expect(yield* fs.exists(harness.file)).toBe(true)
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
          yield* writeControl(control)
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
            yield* writeControl(control)
            yield* Ref.set(harness.mode, "stopped")
          }
          const ready = yield* Deferred.make<void>()
          const released = yield* Ref.make(false)
          const calls = yield* Ref.make(0)
          const serverToken = "b0".repeat(32)
          const serve = (hostname: string, port: number, announce: Parameters<WebServe<never, never>>[2]) =>
            Effect.gen(function*() {
              expect(hostname).toBe("127.0.0.1")
              expect(port).toBe(4321)
              yield* Ref.update(calls, (count) => count + 1)
              yield* Effect.addFinalizer(() => Ref.set(released, true))
              yield* Effect.acquireRelease(
                writeControl({ origin, token: serverToken }),
                () => fs.remove(harness.file).pipe(Effect.orDie)
              )
              yield* announce(url)
              yield* Deferred.succeed(ready, undefined)
              return yield* Effect.never
            })
          const fiber = yield* run(["--port", "4321", "--no-open"], serve).pipe(Effect.forkScoped)
          yield* Deferred.await(ready)
          expect(yield* Ref.get(calls)).toBe(1)
          expect(yield* Ref.get(released)).toBe(false)
          expect(output(yield* Ref.get(harness.stdout))).toBe(`${url}\n${skippedLine("--no-open")}\n`)
          expect(yield* Ref.get(harness.opened)).toEqual([])
          const file = harness.file
          expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600)
          expect(yield* fs.readFileString(file)).toContain(serverToken)
          yield* Fiber.interrupt(fiber)
          expect(yield* Ref.get(released)).toBe(true)
          expect(yield* fs.exists(file)).toBe(false)
        }))
    })
  }

  const failures: ReadonlyArray<readonly ["refused" | "malformed", number]> = [["refused", 401], ["malformed", 200]]
  for (const [mode, status] of failures) {
    it.layer(makeTestLayer())((it) => {
      it.effect(`never starts another server for a ${mode} login reply`, () =>
        Effect.gen(function*() {
          const harness = yield* Harness
          yield* writeControl(control)
          yield* Ref.set(harness.mode, mode)
          const failure = yield* Effect.flip(run([], unexpectedServe))
          expect(failure._tag).toBe("ReportedFailure")
          if (failure._tag !== "ReportedFailure") return yield* Effect.die("Expected the reported login failure")
          expect(failure[Runtime.errorReported]).toBe(false)
          expect(harness.errors).toEqual([
            `CodeCommit web refused the sign-in request (HTTP ${status}). Restart it for a new link.`
          ])
          expect(output(yield* Ref.get(harness.stdout))).toBe("")
          expect(yield* Ref.get(harness.opened)).toEqual([])
          expect(yield* Ref.get(harness.requests)).toEqual([`POST ${origin}/control/login`])
        }))
    })
  }

  it.layer(makeTestLayer())((it) => {
    it.effect("login prints its fresh link without starting or opening", () =>
      Effect.gen(function*() {
        const harness = yield* Harness
        yield* writeControl(control)
        yield* run(["login"], unexpectedServe)
        expect(harness.printed).toEqual([])
        expect(output(yield* Ref.get(harness.stdout))).toBe(`${url}\n`)
        expect(yield* Ref.get(harness.opened)).toEqual([])
        expect(yield* Ref.get(harness.requests)).toEqual([`POST ${origin}/control/login`])
      }))
  })

  // With no reachable control file a taken port is reported plainly; the next port is never tried.
  const conflicts: ReadonlyArray<
    readonly [string, WebServe<{ readonly _tag: "ServeError"; readonly cause: { readonly code: "EADDRINUSE" } }, never>]
  > = [
    ["typed bind failure", () => Effect.fail({ _tag: "ServeError", cause: { code: "EADDRINUSE" } })],
    ["Bun bind defect", () => Effect.die({ message: "Failed to start server. Is port 4321 in use?" })]
  ]
  for (const [name, serve] of conflicts) {
    it.layer(makeTestLayer())((it) => {
      it.effect(`says a taken port cannot be reused (${name}) instead of starting a second server`, () =>
        Effect.gen(function*() {
          const harness = yield* Harness
          const failure = yield* Effect.flip(run(["--port", "4321", "--no-open"], serve))
          expect(failure._tag).toBe("ReportedFailure")
          expect(harness.errors).toEqual([
            "codecommit web: port 4321 is already in use and no running CodeCommit web answered through its control file. If that is a CodeCommit web server it cannot be reused; stop it, or start a new one with --port."
          ])
          expect(output(yield* Ref.get(harness.stdout))).toBe("")
          expect(yield* Ref.get(harness.opened)).toEqual([])
        }))
    })
  }
})
