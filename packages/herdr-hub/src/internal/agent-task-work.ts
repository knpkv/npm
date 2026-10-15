import type { AgentTaskFacts } from "@knpkv/herdr-fleet"
import { type WorkGoalObserved, WorkPullRequestObservation, type WorkSnapshot } from "@knpkv/herdr-work"
import { Result, Schema, SchemaGetter } from "effect"

export type TaskBranchTarget = { readonly repository: string; readonly branch: string }
export type TaskWorkFacts = Pick<AgentTaskFacts, "ci" | "review">
export type TaskWorkObservation = Pick<WorkGoalObserved, "pullRequest" | "unknown" | "stale">
export type TaskWorkSnapshot = Pick<WorkSnapshot, "observedOmitted" | "goalsOmitted"> & {
  readonly observed?: ReadonlyArray<TaskWorkObservation>
}

/** Five minutes bounds retained CI/review evidence; reconfirmation, not a change in facts, renews it. */
export const prTaskConfirmationMaxAgeMs = 5 * 60 * 1000

/** Reads only a unique, current open PR for the agent's exact repository and branch. */
export const branchTaskFacts = (
  snapshot: TaskWorkSnapshot,
  target: TaskBranchTarget,
  now: number
): TaskWorkFacts => {
  const unknown: TaskWorkFacts = { ci: "unknown", review: "unknown" }
  if ((snapshot.observedOmitted ?? 0) > 0 || (snapshot.goalsOmitted ?? 0) > 0) return unknown
  let candidate: WorkPullRequestObservation | undefined
  for (const row of snapshot.observed ?? []) {
    const fact = row.pullRequest?.fact
    if (
      fact === undefined || fact.repository.toLowerCase() !== target.repository.toLowerCase() ||
      fact.branch !== target.branch || fact.state !== "open"
    ) continue
    // Work exposes only its oldest source failure, so any failure may hide a GitHub failure.
    const confirmedAt = row.pullRequest?.confirmedAt
    if (
      row.stale || row.unknown !== null || confirmedAt === undefined ||
      confirmedAt > now || now - confirmedAt > prTaskConfirmationMaxAgeMs
    ) return unknown
    if (
      candidate !== undefined &&
      (candidate.pullRequest !== fact.pullRequest || candidate.head !== fact.head || candidate.checks !== fact.checks ||
        candidate.review !== fact.review)
    ) return unknown
    candidate = fact
  }
  if (candidate === undefined) return unknown
  return {
    ci: candidate.checks === "failing"
      ? "failed"
      : candidate.checks === "passing"
      ? "passed"
      : candidate.checks === "pending"
      ? "pending"
      : "unknown",
    review: candidate.review === "requested" ? "pending" : "complete"
  }
}

const GitHubOrigin = Schema.String.check(
  Schema.isPattern(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/iu
  )
).pipe(
  Schema.decodeTo(WorkPullRequestObservation.fields.repository, {
    decode: SchemaGetter.transform((origin) =>
      origin.replace(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/iu, "").replace(
        /\.git$/iu,
        ""
      ).toLowerCase()
    ),
    encode: SchemaGetter.transform((repository) => `https://github.com/${repository}.git`)
  })
)
const GitBranchTarget = Schema.Struct({ repository: GitHubOrigin, branch: WorkPullRequestObservation.fields.branch })

/** Origin locators remain host-private. This decoder emits only normalized branch identity for local matching. */
export const decodeTaskBranchTarget = (origin: string, branch: string): TaskBranchTarget | undefined => {
  const decoded = Schema.decodeUnknownResult(GitBranchTarget)({ repository: origin, branch })
  return Result.isSuccess(decoded) ? decoded.success : undefined
}
