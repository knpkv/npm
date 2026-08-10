import { type Domain, ReadClient } from "@knpkv/codecommit-core"
import { Effect, Stream } from "effect"
import type { WorktreePlan, WorktreeResult } from "../WorktreeService.js"
import {
  type PullRequestWorkspaceIdentity,
  pullRequestWorkspaceIdentity,
  workspaceIdentityMatches
} from "./details-model.js"
import type { FileDiffOutcome } from "./file-diff.js"

export type PullRequestLocalDiff =
  | { readonly _tag: "provider" }
  | {
    readonly _tag: "ready"
    readonly plan: WorktreePlan
    readonly worktree: WorktreeResult
  }
  | {
    readonly _tag: "outdated"
    readonly plan: WorktreePlan
    readonly worktree: WorktreeResult
  }

export interface PullRequestWorkspace {
  readonly fileDiffs: ReadonlyMap<string, FileDiffOutcome>
  readonly identity: PullRequestWorkspaceIdentity
  readonly revision: ReadClient.CodeCommitPullRequestRevision
  readonly files: ReadonlyArray<ReadClient.CodeCommitChangedFile>
  readonly localDiff: PullRequestLocalDiff
}

export interface PullRequestLocalCheckout {
  readonly identity: PullRequestWorkspaceIdentity
  readonly plan: WorktreePlan
  readonly worktree: WorktreeResult
}

export interface PullRequestRevisionObservation {
  readonly identity: PullRequestWorkspaceIdentity
  readonly revision: ReadClient.CodeCommitPullRequestRevision
}

/** Selects local blobs only while the retained checkout matches the provider's exact revision. */
export const localDiffForWorkspace = (
  identity: PullRequestWorkspaceIdentity,
  revision: Pick<ReadClient.CodeCommitPullRequestRevision, "destinationCommit" | "sourceCommit">,
  checkout: PullRequestLocalCheckout | null
): PullRequestLocalDiff => {
  if (checkout === null || !workspaceIdentityMatches(checkout.identity, identity)) return { _tag: "provider" }
  const value = { plan: checkout.plan, worktree: checkout.worktree }
  return checkout.plan.destinationCommit === revision.destinationCommit &&
      checkout.plan.sourceCommit === revision.sourceCommit &&
      checkout.worktree.sourceCommit === revision.sourceCommit
    ? { _tag: "ready", ...value }
    : { _tag: "outdated", ...value }
}

/** Supplies local blobs only for an exact provider/worktree revision match. */
export const localWorktreePathForDiff = (localDiff: PullRequestLocalDiff): string | undefined =>
  localDiff._tag === "ready" ? localDiff.worktree.path : undefined

/** Detects any exact-review boundary change that invalidates a retained local checkout. */
export const providerRevisionChanged = (
  current: Pick<ReadClient.CodeCommitPullRequestRevision, "destinationCommit" | "sourceCommit">,
  observed: Pick<ReadClient.CodeCommitPullRequestRevision, "destinationCommit" | "sourceCommit">
): boolean => current.destinationCommit !== observed.destinationCommit || current.sourceCommit !== observed.sourceCommit

/** Retains a matching provider observation only when it invalidates the displayed exact revision. */
export const pullRequestProviderDrift = (
  identity: PullRequestWorkspaceIdentity,
  revision: Pick<ReadClient.CodeCommitPullRequestRevision, "destinationCommit" | "sourceCommit">,
  observation: PullRequestRevisionObservation | null
): PullRequestRevisionObservation | null =>
  observation !== null &&
    workspaceIdentityMatches(observation.identity, identity) &&
    providerRevisionChanged(revision, observation.revision)
    ? observation
    : null

/** Refreshes only provider revision metadata so local drift checks never invoke Git. */
export const loadPullRequestRevision = Effect.fn("loadPullRequestRevision")(function*(pr: Domain.PullRequest) {
  const client = yield* ReadClient.CodeCommitReadClient
  const revision = yield* client.getPullRequest({
    account: { profile: pr.account.profile, region: pr.account.region },
    pullRequestId: pr.id
  })
  return { identity: pullRequestWorkspaceIdentity(pr), revision } satisfies PullRequestRevisionObservation
})

/** Opens a PR from provider metadata only; local Git remains an explicit user action. */
export const loadPullRequestWorkspace = Effect.fn("loadPullRequestWorkspace")(function*(pr: Domain.PullRequest) {
  const client = yield* ReadClient.CodeCommitReadClient
  const account = { profile: pr.account.profile, region: pr.account.region }
  const { identity, revision } = yield* loadPullRequestRevision(pr)
  const files = yield* client
    .streamChangedFiles({
      account,
      repositoryName: revision.repositoryName,
      beforeCommitSpecifier: revision.destinationCommit,
      afterCommitSpecifier: revision.sourceCommit
    })
    .pipe(Stream.runCollect)
  return {
    fileDiffs: new Map<string, FileDiffOutcome>(),
    identity,
    revision,
    files: Array.from(files),
    localDiff: { _tag: "provider" }
  } satisfies PullRequestWorkspace
})
