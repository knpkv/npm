import * as NodeServices from "@effect/platform-node/NodeServices"
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

const State = Schema.Literals(["unchanged", "changed", "new", "removed"])
const expectedStatus = {
  new: "skipped",
  unchanged: "passed",
  changed: "failed",
  removed: "failed"
} satisfies Readonly<Record<typeof State.Type, TestResult["status"]>>

/** Controller-owned results survive Playwright worker restarts after comparison failures. */
export default class VisualComparisonReporter implements Reporter {
  private readonly results = new Map<string, typeof State.Type>()
  private infrastructureFailure = false

  onError(): void {
    this.infrastructureFailure = true
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const state = result.annotations.find((annotation) => annotation.type === "visual-state")?.description
    if (Schema.is(State)(state)) {
      this.results.set(test.title, state)
      if (result.status !== expectedStatus[state]) this.infrastructureFailure = true
      if (state === "changed" && !result.attachments.some((attachment) => attachment.name.endsWith("-diff.png"))) {
        this.infrastructureFailure = true
      }
    } else if (result.status !== "passed") {
      this.infrastructureFailure = true
    }
  }

  async onEnd(result: FullResult): Promise<void> {
    const states = [...this.results].sort(([left], [right]) => left.localeCompare(right)).map(([name, state]) => ({
      name,
      state
    }))
    const infrastructureFailure = this.infrastructureFailure || states.length === 0 ||
      result.status === "interrupted" || result.status === "timedout"
    await Effect.runPromise(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const output = path.resolve("test-results/visual")
        yield* fileSystem.makeDirectory(output, { recursive: true })
        yield* fileSystem.writeFileString(
          path.join(output, "comparison.json"),
          JSON.stringify({ infrastructureFailure, states }, null, 2)
        )
        yield* fileSystem.writeFileString(
          path.join(output, "comparison.md"),
          [
            "| State | Result |",
            "| --- | --- |",
            ...states.map(({ name, state }) => `| ${name} | ${state} |`),
            ...(infrastructureFailure ? ["", "Comparison infrastructure failed."] : []),
            ""
          ].join("\n")
        )
      }).pipe(Effect.provide(NodeServices.layer))
    )
  }
}
