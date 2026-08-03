import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { describe, expect, it } from "vitest"

import {
  ensureBoundedGitOutput,
  failClosedVisualClassification,
  MAX_GIT_OUTPUT_BYTES,
  recoverVisualGitFailure,
  VisualGitError
} from "../../scripts/visual/classify-git-changes-effect.js"

describe("visual Git classifier Effect boundary", () => {
  it("fails closed for expected Git and catalog errors", async () => {
    await expect(
      Effect.runPromise(
        recoverVisualGitFailure(Effect.fail(new VisualGitError({ reason: "Git command failed" })))
      )
    ).resolves.toEqual(failClosedVisualClassification)
  })

  it("preserves interruption for the runtime lifecycle", async () => {
    const exit = await Effect.runPromiseExit(recoverVisualGitFailure(Effect.interrupt))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })

  it("preserves defects for runtime error reporting", async () => {
    const exit = await Effect.runPromiseExit(recoverVisualGitFailure(Effect.die("classifier defect")))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true)
  })

  it("preserves the specific bounded-output failure", async () => {
    const failure = await Effect.runPromise(
      ensureBoundedGitOutput("x".repeat(MAX_GIT_OUTPUT_BYTES + 1)).pipe(Effect.flip)
    )

    expect(failure).toEqual(new VisualGitError({ reason: "Git output exceeded the classifier bound" }))
  })
})
