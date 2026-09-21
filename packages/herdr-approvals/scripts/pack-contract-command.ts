import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export class HerdrPackContractError extends Data.TaggedError("HerdrPackContractError")<{
  readonly cause?: unknown
  readonly reason: string
}> {
  override get message(): string {
    return this.reason
  }
}

const diagnosticLimit = 1_024
const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g")
const credentialUrl = /(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi
const windowsDrivePath = /^[A-Za-z]:[\\/]/
const windowsDiagnosticTerminator = String.raw`(?:\s|["':,;!?)}\]])`

const absolutePathArgument = (value: string): boolean => value.startsWith("/") || windowsDrivePath.test(value)

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Redact only the known drive path, accepting Windows-equivalent case and separators at component boundaries. */
const redactPrivateValue = (output: string, privateValue: string): string => {
  if (!windowsDrivePath.test(privateValue)) return output.replaceAll(privateValue, "<path>")
  const normalizedPath = privateValue.replace(/[\\/]+$/, "")
  const pattern = normalizedPath.split(/[\\/]+/).map(escapeRegExp).join("[\\\\/]+")
  const rightBoundary = `(?=$|[\\\\/]|${windowsDiagnosticTerminator})`
  return output.replace(new RegExp(`(^|[^A-Za-z0-9._-])${pattern}${rightBoundary}`, "gi"), "$1<path>")
}

const boundedOutput = (output: string, privateValues: ReadonlyArray<string>): string => {
  let sanitized = output.replace(ansiEscape, "").replace(credentialUrl, "$1<redacted>@")
  const orderedPrivateValues = [...new Set(privateValues.filter((value) => value !== ""))]
    .sort((left, right) => right.length - left.length)
  for (const privateValue of orderedPrivateValues) {
    sanitized = redactPrivateValue(sanitized, privateValue)
  }
  const trimmed = sanitized.trim()
  if (trimmed === "") return "<empty>"
  if (trimmed.length <= diagnosticLimit) return trimmed
  return `<truncated ${trimmed.length - diagnosticLimit} chars>\n${trimmed.slice(-diagnosticLimit)}`
}

const diagnosticPrefix = (phase: string, command: string): string => `phase=${phase}; command=${command}`

const commandError = (phase: string, command: string, action: string) =>
  new HerdrPackContractError({ reason: `${diagnosticPrefix(phase, command)}; ${action}` })

export const runPackContractCommand = Effect.fn("HerdrPackContract.run")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  phase: string,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string
) {
  const handle = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd, stderr: "pipe", stdout: "pipe" })
  ).pipe(Effect.mapError(() => commandError(phase, command, "spawn failed before output capture")))
  const [stdout, stderr, exitCode] = yield* Effect.all([
    Stream.decodeText(handle.stdout).pipe(Stream.mkString),
    Stream.decodeText(handle.stderr).pipe(Stream.mkString),
    handle.exitCode
  ], { concurrency: "unbounded" }).pipe(
    Effect.mapError(() => commandError(phase, command, "output capture failed"))
  )
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    const privateValues = [cwd, ...args.filter(absolutePathArgument)]
    return yield* new HerdrPackContractError({
      reason: `${diagnosticPrefix(phase, command)}; exit=${exitCode}; stdout=${
        boundedOutput(stdout, privateValues)
      }; stderr=${boundedOutput(stderr, privateValues)}`
    })
  }
  return stdout
})
