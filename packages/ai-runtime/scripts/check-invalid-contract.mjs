import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"

import * as Cause from "effect/Cause"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Predicate from "effect/Predicate"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

// `dtslint/public-contract.ts` must fail to compile under the Effect language service, and only because an
// adapter may not raise the validator-owned AgentRuntimeProtocolError. Any other outcome fails this check:
// a clean compile means the contract stopped protecting anything, and a different error (a missing export,
// a renamed type) means it fails for the wrong reason. Run from the package root.

class InvalidContractError extends Data.TaggedError("InvalidContractError") {
  get message() {
    return this.reason
  }
}

const fail = (reason) => new InvalidContractError({ reason })

export const expectedDiagnostics = [
  { file: "dtslint/public-contract.ts", code: "TS377003", mentions: "AgentRuntimeProtocolError" }
]

const diagnosticLine = /^(?<file>\S+)\(\d+,\d+\): error (?<code>TS\d+): (?<text>.*)$/u

/** The error diagnostics tsc printed, or a description of how they differ from the expected ones. */
export const unexpectedDiagnostics = (output) => {
  const errors = output
    .split("\n")
    .map((line) => diagnosticLine.exec(line.trim())?.groups)
    .filter((groups) => groups !== undefined)
  const matches = (error, expected) =>
    error.file === expected.file && error.code === expected.code && error.text.includes(expected.mentions)
  return {
    missing: expectedDiagnostics.filter((expected) => !errors.some((error) => matches(error, expected))),
    unexpected: errors.filter((error) => !expectedDiagnostics.some((expected) => matches(error, expected)))
  }
}

// The expected rejection is an Effect language-service diagnostic, which plain tsc never reports: the root
// `prepare` script patches TypeScript (`effect-tsgo patch --typescript`), and an install run with
// --ignore-scripts skips it. A clean compile therefore usually means that, not a stale contract.
const unpatchedOrStale = [
  "dtslint/public-contract.ts compiled with no errors. Either:",
  "- this TypeScript does not report Effect language-service diagnostics (an install with --ignore-scripts",
  "  skipped the root prepare script); fix: pnpm exec effect-tsgo patch --typescript, or pnpm install; or",
  "- the contract stopped rejecting an adapter that raises AgentRuntimeProtocolError; fix the contract."
].join("\n")

// TS2307 here almost always means a workspace dependency has no built output yet.
const unbuiltDependency = "TS2307 usually means a workspace dependency is not built: run pnpm build first."

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  yield* fileSystem.remove("tsconfig.contract-invalid.tsbuildinfo", { force: true })
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(
    ChildProcess.make("../../node_modules/.bin/tsc", ["-p", "tsconfig.contract-invalid.json"], { extendEnv: true })
  )
  const [output, exitCode] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(Stream.merge(handle.stdout, handle.stderr))), handle.exitCode],
    { concurrency: 2 }
  )
  if (exitCode === ChildProcessSpawner.ExitCode(0)) {
    return yield* fail(unpatchedOrStale)
  }
  const { missing, unexpected } = unexpectedDiagnostics(output)
  if (missing.length > 0 || unexpected.length > 0) {
    return yield* fail(
      [
        "dtslint/public-contract.ts failed for the wrong reason.",
        ...missing.map(({ file, code, mentions }) => `missing: ${file} ${code} mentioning ${mentions}`),
        ...unexpected.map(({ file, code, text }) => `unexpected: ${file} ${code}: ${text}`),
        ...(unexpected.some(({ code }) => code === "TS2307") ? [unbuiltDependency] : [])
      ].join("\n")
    )
  }
  yield* Console.log(`Invalid contract rejected as expected: ${expectedDiagnostics.map(({ code }) => code).join(", ")}`)
}).pipe(Effect.scoped)

// The check's own failure prints its reason alone; anything else (a spawn failure, a defect) its full cause.
const main = program.pipe(
  Effect.tapCause((cause) => {
    const failure = Cause.squash(cause)
    return Console.error(Predicate.isTagged(failure, "InvalidContractError") ? failure.reason : Cause.pretty(cause))
  }),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) NodeRuntime.runMain(main, { disableErrorReporting: true })
