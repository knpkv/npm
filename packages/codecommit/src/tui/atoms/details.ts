import { type Domain, ReadClient } from "@knpkv/codecommit-core"
import { Effect, Stream } from "effect"
import { type RelayReviewKind, runRelayReview } from "../../RelayReview.js"
import { type WorktreePlan, WorktreeService } from "../../WorktreeService.js"
import { buildUnifiedDiff, changedFilePath, filetypeForPath } from "../details-model.js"
import { runtimeAtom } from "./runtime.js"

export interface PullRequestWorkspace {
  readonly revision: ReadClient.CodeCommitPullRequestRevision
  readonly files: ReadonlyArray<ReadClient.CodeCommitChangedFile>
}

export interface RenderedFileDiff {
  readonly binary: boolean
  readonly diff: string
  readonly filetype: string | undefined
  readonly path: string
  readonly truncated: boolean
}

export interface FileDiffRequest {
  readonly account: Domain.Account
  readonly file: ReadClient.CodeCommitChangedFile
  readonly repositoryName: Domain.RepositoryName
}

export interface RelayReviewActionInput {
  readonly kind: RelayReviewKind
  readonly plan: WorktreePlan
  readonly revision: ReadClient.CodeCommitPullRequestRevision
}

const isBinary = (bytes: Uint8Array): boolean => bytes.some((byte) => byte === 0)

const decodeBlob = (bytes: Uint8Array) => Stream.make(bytes).pipe(Stream.decodeText(), Stream.mkString)

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
    return { revision, files: Array.from(files) } satisfies PullRequestWorkspace
  }).pipe(Effect.withSpan("loadPullRequestWorkspace", { attributes: { prId: pr.id } }))
)

export const loadFileDiffAtom = runtimeAtom.fn((request: FileDiffRequest) =>
  Effect.gen(function*() {
    const client = yield* ReadClient.CodeCommitReadClient
    const beforeBytes = request.file.before === null
      ? new Uint8Array()
      : (yield* client.getBlob({
        account: request.account,
        repositoryName: request.repositoryName,
        blobId: request.file.before.blobId
      })).bytes
    const afterBytes = request.file.after === null
      ? new Uint8Array()
      : (yield* client.getBlob({
        account: request.account,
        repositoryName: request.repositoryName,
        blobId: request.file.after.blobId
      })).bytes
    const path = changedFilePath(request.file)
    if (isBinary(beforeBytes) || isBinary(afterBytes)) {
      return { binary: true, diff: "", filetype: undefined, path, truncated: false } satisfies RenderedFileDiff
    }
    const [beforeText, afterText] = yield* Effect.all([decodeBlob(beforeBytes), decodeBlob(afterBytes)])
    const rendered = buildUnifiedDiff(request.file, beforeText, afterText)
    return {
      binary: false,
      diff: rendered.diff,
      filetype: filetypeForPath(path),
      path,
      truncated: rendered.truncated
    } satisfies RenderedFileDiff
  }).pipe(Effect.withSpan("loadFileDiff", { attributes: { path: changedFilePath(request.file) } }))
)

export const preflightWorktreeAtom = runtimeAtom.fn((input: {
  readonly pr: Domain.PullRequest
  readonly revision: ReadClient.CodeCommitPullRequestRevision
}) =>
  Effect.gen(function*() {
    const service = yield* WorktreeService
    return yield* service.preflight({
      account: input.pr.account,
      pullRequestId: input.pr.id,
      repositoryName: input.pr.repositoryName,
      sourceCommit: input.revision.sourceCommit
    })
  }).pipe(Effect.withSpan("preflightWorktree", { attributes: { prId: input.pr.id } }))
)

export const checkoutWorktreeAtom = runtimeAtom.fn((plan: WorktreePlan) =>
  Effect.gen(function*() {
    const service = yield* WorktreeService
    return yield* service.checkout(plan)
  }).pipe(Effect.withSpan("checkoutWorktree", { attributes: { prId: plan.pullRequestId } }))
)

export const runRelayReviewAtom = runtimeAtom.fn((input: RelayReviewActionInput) =>
  Effect.gen(function*() {
    const service = yield* WorktreeService
    const worktree = yield* service.checkout(input.plan)
    const summary = yield* runRelayReview({
      baseCommit: input.revision.destinationCommit,
      headCommit: input.revision.sourceCommit,
      kind: input.kind,
      pullRequestId: input.revision.pullRequestId,
      repositoryName: input.revision.repositoryName,
      title: input.revision.title,
      worktreePath: worktree.path
    })
    return { kind: input.kind, summary, worktree }
  }).pipe(Effect.withSpan("runRelayReview", { attributes: { kind: input.kind } }))
)
