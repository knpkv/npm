import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type { VisualClassification } from "./classify-changes.js"

export class VisualGitError extends Data.TaggedError("VisualGitError")<{
  readonly reason: string
}> {}

export const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024

export const failClosedVisualClassification: VisualClassification = {
  reasons: ["git-or-catalog-failure"],
  scope: "full"
}

/** Reject classifier output before it can grow beyond the process boundary. */
export const ensureBoundedGitOutput = (output: string): Effect.Effect<string, VisualGitError> =>
  output.length > MAX_GIT_OUTPUT_BYTES
    ? Effect.fail(new VisualGitError({ reason: "Git output exceeded the classifier bound" }))
    : Effect.succeed(output)

/** Fail closed for expected Git/catalog errors while preserving defects and interruption. */
export const recoverVisualGitFailure = <E, R>(
  effect: Effect.Effect<VisualClassification, E, R>
): Effect.Effect<VisualClassification, never, R> =>
  effect.pipe(Effect.catch(() => Effect.succeed(failClosedVisualClassification)))
