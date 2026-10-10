import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"

import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

// The numbered decision records under `docs/adr/` directories are the internal decision log. Everywhere
// else (READMEs, docs, comments, specs) states the rule or its reason itself, so a reader never has to
// follow a pointer into the log. This fails on any tracked line outside those directories that names one.

class DecisionRecordMentioned extends Data.TaggedError("DecisionRecordMentioned") {
  get message() {
    return this.reason
  }
}

/** Matches "ADR", "ADRs", "ADR-0009" and a path through an `adr` directory, in any case. */
export const decisionRecordPattern = String.raw`\bADRs?\b|ADR-[0-9]`

const program = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(
    ChildProcess.make(
      "git",
      [
        "grep",
        "-n",
        "-I",
        "-i",
        "-E",
        decisionRecordPattern,
        "--",
        ".",
        ":(exclude,glob)**/docs/adr/**",
        // This check has to name the directory it exempts.
        ":(exclude)scripts/check-no-decision-record-mentions.mjs"
      ],
      { extendEnv: true }
    )
  )
  const [output, exitCode] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
    concurrency: "unbounded"
  })
  // git grep exits 1 when nothing matches.
  if (exitCode === ChildProcessSpawner.ExitCode(1)) {
    yield* Console.log("Decision records: none named outside docs/adr/ directories")
    return
  }
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new DecisionRecordMentioned({ reason: `git grep failed with exit code ${exitCode}` })
  }
  return yield* new DecisionRecordMentioned({
    reason: [
      "Decision records are named outside docs/adr/ directories:",
      output.trimEnd(),
      "Fix: state the rule or its reason in the sentence itself, and drop the reference to the record."
    ].join("\n")
  })
}).pipe(
  Effect.scoped,
  Effect.tapError((error) => Console.error(error.message)),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) NodeRuntime.runMain(program, { disableErrorReporting: true })
