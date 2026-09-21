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

const runWindowsWith = (result: FakeCommandResult) =>
  runPackContractCommand(
    ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(result))),
    "pack @test/windows first",
    "pnpm",
    ["--output", "D:/Sensitive.Path/[output]"],
    "C:\\Users\\[fixture]\\Work"
  )

const runWindowsTrailingWith = (result: FakeCommandResult) =>
  runPackContractCommand(
    ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(result))),
    "pack @test/windows trailing first",
    "pnpm",
    ["--output", "D:/Sensitive.Path/[output]/"],
    "C:/"
  )

const runUncWith = (result: FakeCommandResult) =>
  runPackContractCommand(
    ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(result))),
    "pack @test/windows unc first",
    "pnpm",
    [
      "--output",
      "\\\\ArchiveHost\\Artifacts\\[output]\\",
      "--extended",
      "\\\\?\\C:\\fixture",
      "--device",
      "\\\\.\\pipe\\fixture"
    ],
    "\\\\ServerName\\ShareName\\Private.Path[fixture]\\"
  )

const runUncRootWith = (result: FakeCommandResult) =>
  runPackContractCommand(
    ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(result))),
    "pack @test/windows unc root first",
    "pnpm",
    ["--output", "\\\\ArgumentServer\\ArgumentShare\\"],
    "\\\\RootServer\\RootShare\\"
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

  it.effect("sanitizes drive-qualified private paths across case and separator variants", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(runWindowsWith({
        exitCode: 17,
        stdout: [
          "quoted \"c:/users/[FIXTURE]/work\", retry refused",
          "whitespace C:\\USERS\\[fixture]\\WORK retry refused",
          "punctuation C:/Users/[fixture]/Work: access denied"
        ].join("\n"),
        stderr: [
          "cwd c:/users/[FIXTURE]/work\\diagnostics.txt",
          "output d:\\sensitive.path\\[OUTPUT]/archive.tgz",
          "newline C:/Users/[fixture]/Work",
          "retry refused",
          "sibling C:\\Users\\[fixture]\\Work-old\\kept.txt",
          "extension C:\\Users\\[fixture]\\Work.bak\\kept.txt",
          "embedded prefixC:\\Users\\[fixture]\\Work\\kept.txt",
          "other E:\\Users\\[fixture]\\Work\\kept.txt",
          "posix /PRIVATE/workspace/kept.txt",
          "exact C:/Users/[fixture]/Work"
        ].join("\n")
      }))
      const rendered = Cause.pretty(Cause.fail(error))

      expect(rendered).toContain("quoted \"<path>\", retry refused")
      expect(rendered).toContain("whitespace <path> retry refused")
      expect(rendered).toContain("punctuation <path>: access denied")
      expect(rendered).toContain("cwd <path>\\diagnostics.txt")
      expect(rendered).toContain("output <path>/archive.tgz")
      expect(rendered).toContain("newline <path>\nretry refused")
      expect(rendered).toContain("sibling C:\\Users\\[fixture]\\Work-old\\kept.txt")
      expect(rendered).toContain("extension C:\\Users\\[fixture]\\Work.bak\\kept.txt")
      expect(rendered).toContain("embedded prefixC:\\Users\\[fixture]\\Work\\kept.txt")
      expect(rendered).toContain("other E:\\Users\\[fixture]\\Work\\kept.txt")
      expect(rendered).toContain("posix /PRIVATE/workspace/kept.txt")
      expect(rendered).toContain("exact <path>")
      expect(rendered).not.toContain("c:/users/[FIXTURE]/work")
      expect(rendered).not.toContain("d:\\sensitive.path\\[OUTPUT]")
    }))

  it.effect("sanitizes descendants of drive roots and directories configured with trailing separators", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(runWindowsTrailingWith({
        exitCode: 19,
        stderr: "root c:/Users/[fixture]/Work/file.ts",
        stdout: "directory d:\\sensitive.path\\[OUTPUT]\\archive.tgz"
      }))
      const rendered = Cause.pretty(Cause.fail(error))

      expect(rendered).toContain("directory <path>\\archive.tgz")
      expect(rendered).toContain("root <path>/Users/[fixture]/Work/file.ts")
      expect(rendered).not.toContain("c:/Users/[fixture]")
      expect(rendered).not.toContain("d:\\sensitive.path\\[OUTPUT]")
    }))

  it.effect("sanitizes conventional UNC private paths across case and separator variants", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(runUncWith({
        exitCode: 23,
        stderr: [
          "cwd //servername/sharename/private.path[FIXTURE]/diagnostics.txt",
          "argument \\\\ARCHIVEHOST\\ARTIFACTS\\[OUTPUT]\\archive.tgz",
          "exact \\\\ServerName\\ShareName\\Private.Path[fixture]"
        ].join("\n"),
        stdout: [
          "quoted \"//SERVERNAME/SHARENAME/PRIVATE.PATH[fixture]\", refused",
          "whitespace \\\\servername\\sharename\\private.path[FIXTURE] refused",
          "argument //archivehost/artifacts/[OUTPUT]/stdout.tgz",
          "different server //other/sharename/private.path[fixture]/kept.txt",
          "different share //servername/other/private.path[fixture]/kept.txt",
          "sibling //servername/sharename/private.path[fixture]-old/kept.txt",
          "extension //servername/sharename/private.path[fixture].bak/kept.txt",
          "embedded prefix//servername/sharename/private.path[fixture]/kept.txt",
          "extended \\\\?\\C:\\fixture",
          "device \\\\.\\pipe\\fixture",
          "unrelated argument //archivehost/other/[output]/kept.tgz"
        ].join("\n")
      }))
      const rendered = Cause.pretty(Cause.fail(error))

      expect(rendered).toContain("quoted \"<path>\", refused")
      expect(rendered).toContain("whitespace <path> refused")
      expect(rendered).toContain("cwd <path>/diagnostics.txt")
      expect(rendered).toContain("argument <path>\\archive.tgz")
      expect(rendered).toContain("argument <path>/stdout.tgz")
      expect(rendered).toContain("exact <path>")
      expect(rendered).toContain("different server //other/sharename/private.path[fixture]/kept.txt")
      expect(rendered).toContain("different share //servername/other/private.path[fixture]/kept.txt")
      expect(rendered).toContain("sibling //servername/sharename/private.path[fixture]-old/kept.txt")
      expect(rendered).toContain("extension //servername/sharename/private.path[fixture].bak/kept.txt")
      expect(rendered).toContain("embedded prefix//servername/sharename/private.path[fixture]/kept.txt")
      expect(rendered).toContain("extended \\\\?\\C:\\fixture")
      expect(rendered).toContain("device \\\\.\\pipe\\fixture")
      expect(rendered).toContain("unrelated argument //archivehost/other/[output]/kept.tgz")
      expect(rendered).not.toContain("//servername/sharename/private.path[FIXTURE]")
      expect(rendered).not.toContain("\\\\ARCHIVEHOST\\ARTIFACTS\\[OUTPUT]")
    }))

  it.effect("preserves UNC share-root meaning when configured paths have trailing separators", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(runUncRootWith({
        exitCode: 29,
        stderr: [
          "argument \\\\ARGUMENTSERVER\\ARGUMENTSHARE\\archive.tgz",
          "other share //argumentserver/other/archive.tgz"
        ].join("\n"),
        stdout: [
          "cwd //rootserver/rootshare/fixture/file.ts",
          "root \\\\ROOTSERVER\\ROOTSHARE",
          "different server //other/rootshare/fixture/file.ts"
        ].join("\n")
      }))
      const rendered = Cause.pretty(Cause.fail(error))

      expect(rendered).toContain("cwd <path>/fixture/file.ts")
      expect(rendered).toContain("root <path>")
      expect(rendered).toContain("argument <path>\\archive.tgz")
      expect(rendered).toContain("other share //argumentserver/other/archive.tgz")
      expect(rendered).toContain("different server //other/rootshare/fixture/file.ts")
      expect(rendered).not.toContain("//rootserver/rootshare")
      expect(rendered).not.toContain("\\\\ARGUMENTSERVER\\ARGUMENTSHARE")
    }))

  it.effect("returns successful stdout unchanged", () =>
    Effect.gen(function*() {
      const stdout = `package built at ${privatePath} from HTTPS://${privateCredential}@example.invalid/archive\n`
      expect(yield* runWith({ stderr: "warning\n", stdout })).toBe(stdout)
    }))
})
