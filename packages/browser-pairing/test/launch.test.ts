import { describe, expect, it } from "@effect/vitest"
import { Context, Data, Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Ref, Sink, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Stdio from "effect/Stdio"
import {
  browserLaunch,
  type BrowserLaunchInput,
  BrowserLaunchOutputError,
  BrowserOpener,
  BrowserOpenError,
  openBrowser,
  openOrServe,
  skippedLine
} from "../src/launch.js"

const atTerminal: BrowserLaunchInput = { noOpen: false, browser: undefined, ci: undefined, interactive: true }
const url = "http://127.0.0.1:3111/#bootstrap_token=test-code"

class LoginUnavailable extends Data.TaggedError("LoginUnavailable") {}
class ServeUnavailable extends Data.TaggedError("ServeUnavailable") {}

/** Capture stdout/stderr separately and substitute a browser opener that never launches a process. */
const makeLaunchHarness = Effect.gen(function*() {
  const stdout = yield* Ref.make<ReadonlyArray<string | Uint8Array>>([])
  const stderr = yield* Ref.make<ReadonlyArray<string | Uint8Array>>([])
  const opened = yield* Ref.make<ReadonlyArray<string>>([])
  const warnings: Array<unknown> = []
  return {
    stdout,
    stderr,
    opened,
    warnings,
    layer: Layer.mergeAll(
      Stdio.layerTest({
        stdout: () => Sink.forEach((chunk: string | Uint8Array) => Ref.update(stdout, (chunks) => [...chunks, chunk])),
        stderr: () => Sink.forEach((chunk: string | Uint8Array) => Ref.update(stderr, (chunks) => [...chunks, chunk]))
      }),
      Layer.succeed(
        BrowserOpener,
        BrowserOpener.of({ open: (value) => Ref.update(opened, (values) => [...values, value]) })
      ),
      Logger.layer([Logger.make<unknown, void>(({ message }) => {
        warnings.push(message)
      })])
    )
  }
})

class LaunchHarness extends Context.Service<LaunchHarness, Effect.Success<typeof makeLaunchHarness>>()(
  "@knpkv/browser-pairing/test/LaunchHarness"
) {}

const launchHarnessLayer = Layer.unwrap(
  Effect.map(makeLaunchHarness, (harness) => Layer.mergeAll(Layer.succeed(LaunchHarness, harness), harness.layer))
)

/** Fail the first N spawn attempts, then return the supplied numeric exit code. */
const recordingSpawner = (failureCount: number, exitCode = 0) =>
  Effect.gen(function*() {
    const commands = yield* Ref.make<ReadonlyArray<ChildProcess.Command>>([])
    const warnings: Array<unknown> = []
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function*() {
        yield* Ref.update(commands, (values) => [...values, command])
        if ((yield* Ref.get(commands)).length <= failureCount) {
          return yield* new PlatformError.PlatformError(
            new PlatformError.SystemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: `Cannot spawn an opener for ${url}`
            })
          )
        }
        return ChildProcessSpawner.makeHandle({
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          pid: ChildProcessSpawner.ProcessId(7),
          stderr: Stream.empty,
          stdin: Sink.drain,
          stdout: Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
    )
    return {
      commands,
      warnings,
      layer: Layer.mergeAll(
        BrowserOpener.layer.pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
        Logger.layer([Logger.make<unknown, void>(({ message }) => {
          warnings.push(message)
        })])
      )
    }
  })

class SpawnerHarness extends Context.Service<SpawnerHarness, Effect.Success<ReturnType<typeof recordingSpawner>>>()(
  "@knpkv/browser-pairing/test/SpawnerHarness"
) {}

const spawnerHarnessLayer = (failures: number, exitCode = 0) =>
  Layer.unwrap(
    Effect.map(recordingSpawner(failures, exitCode), (harness) =>
      Layer.mergeAll(Layer.succeed(SpawnerHarness, harness), harness.layer))
  )

const failedOpenerLayer = Layer.succeed(
  BrowserOpener,
  BrowserOpener.of({
    open: () => Effect.fail(new BrowserOpenError({}))
  })
)

const failedStdoutLayer = Stdio.layerTest({
  stdout: () =>
    Sink.fail(
      new PlatformError.PlatformError(
        new PlatformError.SystemError({
          _tag: "Unknown",
          module: "Stdio",
          method: "stdout",
          description: url
        })
      )
    )
})

describe("browser launch policy", () => {
  it("opens only when no skip condition applies", () => {
    expect(browserLaunch(atTerminal)).toEqual({ _tag: "Open" })
    expect(browserLaunch({ ...atTerminal, browser: "firefox" })).toEqual({ _tag: "Open" })
    for (const ci of [undefined, "", "0", "false", " FALSE "]) {
      expect(browserLaunch({ ...atTerminal, ci })).toEqual({ _tag: "Open" })
    }
  })

  it("keeps skip reasons and their precedence", () => {
    const cases: ReadonlyArray<readonly [BrowserLaunchInput, string]> = [
      [{ ...atTerminal, noOpen: true, browser: "none", ci: "true", interactive: false }, "--no-open"],
      [{ ...atTerminal, browser: " None ", ci: "true", interactive: false }, "BROWSER=none"],
      [{ ...atTerminal, ci: "true", interactive: false }, "CI is set"],
      [{ ...atTerminal, ci: "1" }, "CI is set"],
      [{ ...atTerminal, interactive: false }, "not an interactive terminal"]
    ]
    for (const [input, reason] of cases) expect(browserLaunch(input)).toEqual({ _tag: "Skip", reason })
    expect(skippedLine("--no-open")).toBe("Not opening a browser (--no-open); open the link above.")
  })
})

describe("browser opener", () => {
  for (const failures of [0, 1, 2]) {
    it.layer(spawnerHarnessLayer(failures))((it) => {
      it.effect(`tries platform openers in order after ${failures} failures`, () =>
        Effect.gen(function*() {
          const harness = yield* SpawnerHarness
          const names = ["open", "xdg-open", "rundll32.exe"]
          yield* openBrowser(url)
          const commands = yield* Ref.get(harness.commands)
          expect(commands.map((command) => ChildProcess.isStandardCommand(command) ? command.command : "pipeline"))
            .toEqual(names.slice(0, failures + 1))
          for (const command of commands) {
            expect(ChildProcess.isStandardCommand(command)).toBe(true)
            if (!ChildProcess.isStandardCommand(command)) return
            expect(command.args).toEqual(
              command.command === "rundll32.exe" ? ["url.dll,FileProtocolHandler", url] : [url]
            )
            expect(command.options).toMatchObject({ stdin: "ignore", stdout: "ignore", stderr: "ignore" })
          }
        }))
    })
  }

  it.layer(spawnerHarnessLayer(0, 1))((it) => {
    it.effect("preserves the existing nonzero-exit policy without trying another opener", () =>
      Effect.gen(function*() {
        const harness = yield* SpawnerHarness
        yield* openBrowser(url)
        expect((yield* Ref.get(harness.commands)).length).toBe(1)
      }))
  })

  // Both the direct call and best-effort call must exhaust all three openers.
  it.layer(spawnerHarnessLayer(6))((it) => {
    it.effect("replaces credential-bearing process failures with a sanitized error and fixed warning", () =>
      Effect.gen(function*() {
        const harness = yield* SpawnerHarness
        const opener = yield* BrowserOpener
        const error = yield* Effect.flip(opener.open(url))
        expect(error).toBeInstanceOf(BrowserOpenError)
        expect(JSON.stringify(error)).not.toContain(url)
        yield* openBrowser(url)
        expect(harness.warnings).toEqual([["No browser could be opened; open the link above"]])
        expect((yield* Ref.get(harness.commands)).length).toBe(6)
      }))
  })
})

describe("openOrServe", () => {
  it.layer(launchHarnessLayer)((it) => {
    it.effect("prints and opens a reused server URL, returns, and never touches its lifecycle", () =>
      Effect.gen(function*() {
        const harness = yield* LaunchHarness
        const served = yield* Ref.make(false)
        const loginCalls = yield* Ref.make(0)
        const result = yield* openOrServe({
          login: Ref.update(loginCalls, (count) => count + 1).pipe(Effect.as(Option.some(url))),
          serve: () => Ref.set(served, true).pipe(Effect.andThen(Effect.never)),
          launch: browserLaunch(atTerminal)
        })
        expect(result).toBeUndefined()
        expect(yield* Ref.get(loginCalls)).toBe(1)
        expect(yield* Ref.get(served)).toBe(false)
        expect(yield* Ref.get(harness.stdout)).toEqual([`${url}\n`])
        expect(yield* Ref.get(harness.stderr)).toEqual([])
        expect(yield* Ref.get(harness.opened)).toEqual([url])
      }))
  })

  it.layer(launchHarnessLayer)((it) => {
    it.effect("accepts a direct URL without a pairing credential", () =>
      Effect.gen(function*() {
        const harness = yield* LaunchHarness
        const directUrl = "https://hub.example.test/"
        yield* openOrServe({
          login: Effect.succeed(Option.some(directUrl)),
          serve: () => Effect.die("A reused URL must not start a server"),
          launch: browserLaunch(atTerminal)
        })
        expect(yield* Ref.get(harness.stdout)).toEqual([`${directUrl}\n`])
        expect(yield* Ref.get(harness.opened)).toEqual([directUrl])
      }))
  })

  it.layer(launchHarnessLayer)((it) => {
    it.effect("keeps a started server alive after readiness and releases its scope on interruption", () =>
      Effect.gen(function*() {
        const harness = yield* LaunchHarness
        const announced = yield* Deferred.make<void>()
        const stopped = yield* Deferred.make<void>()
        const run = yield* openOrServe({
          login: Effect.succeed(Option.none()),
          serve: (onReady) =>
            Effect.gen(function*() {
              yield* Effect.acquireRelease(Effect.void, () => Deferred.succeed(stopped, undefined))
              yield* onReady(url)
              yield* Deferred.succeed(announced, undefined)
              return yield* Effect.never
            }),
          launch: browserLaunch(atTerminal)
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(announced)
        expect(yield* Ref.get(harness.stdout)).toEqual([`${url}\n`])
        expect(yield* Ref.get(harness.opened)).toEqual([url])
        expect(yield* Deferred.isDone(stopped)).toBe(false)
        expect(run.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(run)
        expect(yield* Deferred.isDone(stopped)).toBe(true)
      }))
  })

  it.layer(launchHarnessLayer)((it) => {
    it.effect("prints only the URL and skip reason with noOpen", () =>
      Effect.gen(function*() {
        const harness = yield* LaunchHarness
        yield* openOrServe({
          login: Effect.succeed(Option.some(url)),
          serve: () => Effect.die("A reused URL must not start a server"),
          launch: browserLaunch({ ...atTerminal, noOpen: true })
        })
        expect(yield* Ref.get(harness.stdout)).toEqual([`${url}\n`, `${skippedLine("--no-open")}\n`])
        expect(yield* Ref.get(harness.stderr)).toEqual([])
        expect(yield* Ref.get(harness.opened)).toEqual([])
      }))
  })

  it.layer(Layer.mergeAll(launchHarnessLayer, failedOpenerLayer))((it) => {
    it.effect("keeps the printed URL usable when a browser cannot be opened", () =>
      Effect.gen(function*() {
        const harness = yield* LaunchHarness
        yield* openOrServe({
          login: Effect.succeed(Option.some(url)),
          serve: () => Effect.die("A reused URL must not start a server"),
          launch: browserLaunch(atTerminal)
        })
        expect(yield* Ref.get(harness.stdout)).toEqual([`${url}\n`])
        expect(yield* Ref.get(harness.stderr)).toEqual([])
        expect(harness.warnings).toEqual([["No browser could be opened; open the link above"]])
      }))
  })

  it.layer(launchHarnessLayer)((it) => {
    it.effect("propagates login failure without starting or announcing a server", () =>
      Effect.gen(function*() {
        const harness = yield* LaunchHarness
        const served = yield* Ref.make(false)
        const error = new LoginUnavailable()
        const result = yield* Effect.result(openOrServe({
          login: Effect.fail(error),
          serve: () => Ref.set(served, true).pipe(Effect.andThen(Effect.never)),
          launch: browserLaunch(atTerminal)
        }))
        expect(result).toMatchObject({ _tag: "Failure", failure: error })
        expect(yield* Ref.get(served)).toBe(false)
        expect(yield* Ref.get(harness.stdout)).toEqual([])
        expect(yield* Ref.get(harness.opened)).toEqual([])
      }))
  })

  it.layer(launchHarnessLayer)((it) => {
    it.effect("propagates startup failure without printing a URL for an absent listener", () =>
      Effect.gen(function*() {
        const harness = yield* LaunchHarness
        const error = new ServeUnavailable()
        const result = yield* Effect.result(openOrServe({
          login: Effect.succeed(Option.none()),
          serve: () => Effect.fail(error),
          launch: browserLaunch(atTerminal)
        }))
        expect(result).toMatchObject({ _tag: "Failure", failure: error })
        expect(yield* Ref.get(harness.stdout)).toEqual([])
        expect(yield* Ref.get(harness.opened)).toEqual([])
      }))
  })

  it.layer(Layer.mergeAll(launchHarnessLayer, failedStdoutLayer))((it) => {
    it.effect("sanitizes stdout failure, stops the started server, and never opens an unprinted URL", () =>
      Effect.gen(function*() {
        const harness = yield* LaunchHarness
        const stopped = yield* Deferred.make<void>()
        const result = yield* Effect.exit(openOrServe({
          login: Effect.succeed(Option.none()),
          serve: (onReady) =>
            Effect.gen(function*() {
              yield* Effect.acquireRelease(Effect.void, () => Deferred.succeed(stopped, undefined))
              yield* onReady(url)
              return yield* Effect.never
            }),
          launch: browserLaunch(atTerminal)
        }))
        expect(Exit.isFailure(result)).toBe(true)
        if (!Exit.isFailure(result)) return
        expect(JSON.stringify(result)).toContain("BrowserLaunchOutputError")
        expect(JSON.stringify(result)).not.toContain(url)
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect(yield* Ref.get(harness.opened)).toEqual([])
        expect(new BrowserLaunchOutputError({}).message).toBe("Could not print the browser link to stdout")
      }))
  })
})
