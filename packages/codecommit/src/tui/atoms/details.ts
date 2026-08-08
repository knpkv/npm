import { type Domain, ReadClient } from "@knpkv/codecommit-core"
import { Effect, Stream } from "effect"
import { type RelayReviewKind, runRelayReview } from "../../RelayReview.js"
import { type WorktreePlan, WorktreeService } from "../../WorktreeService.js"
import {
  actionOutcome,
  changedFilePath,
  type FileDiffIdentity,
  fileDiffIdentity,
  type PullRequestWorkspaceIdentity,
  pullRequestWorkspaceIdentity
} from "../details-model.js"
import { type FileDiffRequest, loadFileDiff, type RenderedFileDiff } from "../file-diff.js"
import { runtimeAtom } from "./runtime.js"

export interface PullRequestWorkspace {
  readonly identity: PullRequestWorkspaceIdentity
  readonly revision: ReadClient.CodeCommitPullRequestRevision
  readonly files: ReadonlyArray<ReadClient.CodeCommitChangedFile>
}

export interface RelayReviewActionInput {
  readonly kind: RelayReviewKind
  readonly plan: WorktreePlan
  readonly requestId: string
  readonly revision: ReadClient.CodeCommitPullRequestRevision
}

export interface WorktreeActionInput {
  readonly plan: WorktreePlan
  readonly requestId: string
}

export type FileDiffOutcome =
  | { readonly _tag: "failure"; readonly identity: FileDiffIdentity }
  | { readonly _tag: "success"; readonly identity: FileDiffIdentity; readonly value: RenderedFileDiff }

export const loadPullRequestWorkspaceAtom = runtimeAtom.fn((pr: Domain.PullRequest) =>
  Effect.gen(function*() {
    const client = yield* ReadClient.CodeCommitReadClient
    const account = { profile: pr.account.profile, region: pr.account.region }
    const revision = yield* client.getPullRequest({ account, pullRequestId: pr.id })
    const files = yield* client.streamChangedFiles({
      account,
      repositoryName: revision.repositoryName,
      beforeCommitSpecifier: revision.destinationCommit,
      afterCommitSpecifier: revision.sourceCommit
    }).pipe(Stream.runCollect)
    return {
      identity: pullRequestWorkspaceIdentity(pr),
      revision,
      files: Array.from(files)
    } satisfies PullRequestWorkspace
  }).pipe(Effect.withSpan("loadPullRequestWorkspace", { attributes: { prId: pr.id } }))
)

export const loadFileDiffAtom = runtimeAtom.fn((request: FileDiffRequest) =>
  Effect.gen(function*() {
    const client = yield* ReadClient.CodeCommitReadClient
    const identity = fileDiffIdentity(request.identity, request.revision, request.file)
    return yield* loadFileDiff(client, request).pipe(
      Effect.match({
        onFailure: (): FileDiffOutcome => ({ _tag: "failure", identity }),
        onSuccess: (value): FileDiffOutcome => ({ _tag: "success", identity, value })
      })
    )
  }).pipe(Effect.withSpan("loadFileDiffAtom", { attributes: { path: changedFilePath(request.file) } }))
)

export const preflightWorktreeAtom = runtimeAtom.fn((input: {
  readonly pr: Domain.PullRequest
  readonly requestId: string
  readonly revision: ReadClient.CodeCommitPullRequestRevision
}) =>
  Effect.gen(function*() {
    const service = yield* WorktreeService
    return yield* actionOutcome(
      input.requestId,
      service.preflight({
        account: input.pr.account,
        destinationCommit: input.revision.destinationCommit,
        destinationReference: input.pr.destinationBranch,
        pullRequestId: input.pr.id,
        repositoryName: input.pr.repositoryName,
        sourceCommit: input.revision.sourceCommit,
        sourceReference: input.pr.sourceBranch
      })
    )
  }).pipe(Effect.withSpan("preflightWorktree", { attributes: { prId: input.pr.id } }))
)

export const checkoutWorktreeAtom = runtimeAtom.fn((input: WorktreeActionInput) =>
  Effect.gen(function*() {
    const service = yield* WorktreeService
    return yield* actionOutcome(input.requestId, service.checkout(input.plan))
  }).pipe(Effect.withSpan("checkoutWorktree", { attributes: { prId: input.plan.pullRequestId } }))
)

export const runRelayReviewAtom = runtimeAtom.fn((input: RelayReviewActionInput) =>
  Effect.gen(function*() {
    const service = yield* WorktreeService
    return yield* actionOutcome(
      input.requestId,
      Effect.gen(function*() {
        const worktree = yield* service.checkout(input.plan)
        const summary = yield* runRelayReview({
          baseCommit: input.revision.destinationCommit,
          headCommit: input.revision.sourceCommit,
          kind: input.kind,
          pullRequestId: input.revision.pullRequestId,
          repositoryName: input.revision.repositoryName,
          worktreePath: worktree.path
        })
        return { kind: input.kind, summary, worktree }
      })
    )
  }).pipe(Effect.withSpan("runRelayReview", { attributes: { kind: input.kind } }))
)
