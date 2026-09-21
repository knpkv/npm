import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Sink, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { HerdrPackContractError, runPackContractCommand } from "../scripts/pack-contract-command.js"

interface FakeCommandResult {
  readonly exitCode?: number
  readonly stderr?: string
  readonly stderrFailure?: PlatformError.PlatformError
  readonly stdout?: string
  readonly stdoutFailure?: PlatformError.PlatformError
}

const fakeHandle = ({
  exitCode = 0,
  stderr = "",
  stderrFailure,
  stdout = "",
  stdoutFailure
}: FakeCommandResult) => {
  const stderrStream = stderrFailure === undefined
    ? Stream.make(stderr).pipe(Stream.encodeText)
    : Stream.fail(stderrFailure)
  const stdoutStream = stdoutFailure === undefined
    ? Stream.make(stdout).pipe(Stream.encodeText)
    : Stream.fail(stdoutFailure)
  return ChildProcessSpawner.makeHandle({
    all: Stream.concat(stdoutStream, stderrStream),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    pid: ChildProcessSpawner.ProcessId(42),
    stderr: stderrStream,
    stdin: Sink.drain,
    stdout: stdoutStream,
    unref: Effect.succeed(Effect.void)
  })
}

const runWith = (result: FakeCommandResult) =>
  runPackContractCommand(
    ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(result))),
    "pack @test/example first",
    "pnpm",
    ["--filter", "@test/example", "run", "pack:deterministic", "--", "/private/output"],
    "/private/workspace"
  )

const privatePath = "/private/workspace/customer-fixture"
const privateCredential = "fixture-user:fixture-password"
const longPrivateSentinel = `fixture-private-${"z".repeat(2_000)}`

const nestedPlatformFailure = (stage: string) =>
  new PlatformError.PlatformError(
    new PlatformError.SystemError({
      _tag: "NotFound",
      cause: new Error(`nested ${longPrivateSentinel}`, {
        cause: new Error(`credential ${privateCredential}`)
      }),
      description: `${stage} at ${privatePath} using HTTPS://${privateCredential}@example.invalid/private`,
      method: stage,
      module: "ChildProcess",
      pathOrDescriptor: privatePath
    })
  )

const expectSafeRenderedFailure = (rendered: string, stage: string) => {
  expect(rendered).toContain("pack @test/example first")
  expect(rendered).toContain("command=pnpm")
  expect(rendered).toContain(stage)
  expect(rendered).not.toContain(privatePath)
  expect(rendered).not.toContain(privateCredential)
  expect(rendered).not.toContain(longPrivateSentinel)
  expect(rendered.length).toBeLessThan(2_500)
}

describe("pack contract command diagnostics", () => {
  it.effect("reports stdout-only nonzero failures without private paths or unbounded output", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(runWith({
        exitCode: 7,
        stdout: `${"x".repeat(3_000)}\narchive: /private/output/example.tgz\n`
      }))

      expect(error.reason).toContain("pack @test/example first")
      expect(error.reason).toContain("command=pnpm")
      expect(error.reason).toContain("exit=7")
      expect(error.reason).toContain("stdout=")
      expect(error.reason).toContain("archive: <path>/example.tgz")
      expect(error.reason).toContain("stderr=<empty>")
      expect(error.reason).not.toContain("/private")
      expect(error.reason.length).toBeLessThan(2_500)
      expect(error.message).toBe(error.reason)
      expect(String(error)).toContain(error.reason)
      expect(Cause.pretty(Cause.fail(error))).toContain(error.reason)
    }))

  it.effect("reports stderr-only nonzero failures", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(runWith({ exitCode: 9, stderr: "compiler refused input\n" }))

      expect(error.reason).toContain("exit=9")
      expect(error.reason).toContain("stdout=<empty>")
      expect(error.reason).toContain("stderr=compiler refused input")
    }))

  it.effect("retains typed spawn failures without rendering the nested platform cause", () => {
    const failure = nestedPlatformFailure("spawn")
    const spawner = ChildProcessSpawner.make(() => Effect.fail(failure))

    return Effect.gen(function*() {
      const error = yield* Effect.flip(
        runPackContractCommand(spawner, "pack @test/example first", "pnpm", [], "/private/workspace")
      )

      expect(error).toBeInstanceOf(HerdrPackContractError)
      expect(error.reason).toContain("pack @test/example first")
      expect(error.reason).toContain("command=pnpm")
      expect(error.reason).toContain("spawn failed")
      expect(error.reason).not.toContain("/private")
      expect(error.message).toBe(error.reason)
      expectSafeRenderedFailure(Cause.pretty(Cause.fail(error)), "spawn failed before output capture")
    })
  })

  it.effect("retains typed capture failures without rendering the nested platform cause", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(runWith({ stdoutFailure: nestedPlatformFailure("capture stdout") }))

      expect(error).toBeInstanceOf(HerdrPackContractError)
      expectSafeRenderedFailure(Cause.pretty(Cause.fail(error)), "output capture failed")
    }))

  it.effect("sanitizes mixed-case and ANSI-colored basic-auth URLs before truncation", () =>
    Effect.gen(function*() {
      const escape = String.fromCharCode(27)
      const error = yield* Effect.flip(runWith({
        exitCode: 13,
        stderr: `compiler: hTtPs://${privateCredential}@stderr.example.invalid/file.ts:1:2`,
        stdout: `${
          "x".repeat(1_500)
        }\n${escape}[31mHTTP${escape}[0m://${privateCredential}@stdout.example.invalid/archive.tgz\nhttps://example.invalid/docs`
      }))

      expect(error.reason).toContain("HTTP://<redacted>@stdout.example.invalid/archive.tgz")
      expect(error.reason).toContain("https://example.invalid/docs")
      expect(error.reason).toContain("compiler: hTtPs://<redacted>@stderr.example.invalid/file.ts:1:2")
      expect(error.reason).toContain("<truncated ")
      expect(error.reason).not.toContain(privateCredential)
      expect(error.reason).not.toContain(escape)
    }))

  it.effect("returns successful stdout unchanged", () =>
    Effect.gen(function*() {
      const stdout = `package built at ${privatePath} from HTTPS://${privateCredential}@example.invalid/archive\n`
      expect(yield* runWith({ stderr: "warning\n", stdout })).toBe(stdout)
    }))
})
