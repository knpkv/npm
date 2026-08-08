import { type Domain, ReadClient } from "@knpkv/codecommit-core"
import { Effect, Stream } from "effect"
import { type RelayReviewKind, runRelayReview } from "../../RelayReview.js"
import { type WorktreePlan, WorktreeService } from "../../WorktreeService.js"
import {
  blobPreviewDisposition,
  buildUnifiedDiff,
  changedFilePath,
  type FileDiffIdentity,
  fileDiffIdentity,
  filetypeForPath,
  type PullRequestWorkspaceIdentity,
  pullRequestWorkspaceIdentity
} from "../details-model.js"
import { runtimeAtom } from "./runtime.js"

export interface PullRequestWorkspace {
  readonly identity: PullRequestWorkspaceIdentity
  readonly revision: ReadClient.CodeCommitPullRequestRevision
  readonly files: ReadonlyArray<ReadClient.CodeCommitChangedFile>
}

export interface RenderedFileDiff {
  readonly binary: boolean
  readonly diff: string
  readonly filetype: string | undefined
  readonly identity: FileDiffIdentity
  readonly metadata: string | null
  readonly path: string
  readonly truncated: boolean
}

export interface FileDiffRequest {
  readonly account: Domain.Account
  readonly file: ReadClient.CodeCommitChangedFile
  readonly identity: PullRequestWorkspaceIdentity
  readonly repositoryName: Domain.RepositoryName
  readonly revision: ReadClient.CodeCommitPullRequestRevision
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

export type ActionOutcome<A> =
  | { readonly _tag: "failure"; readonly requestId: string }
  | { readonly _tag: "success"; readonly requestId: string; readonly value: A }

const actionFailure = (requestId: string): ActionOutcome<never> => ({ _tag: "failure", requestId })
const actionSuccess = <A>(requestId: string, value: A): ActionOutcome<A> => ({ _tag: "success", requestId, value })

const actionOutcome = <A, E, R>(requestId: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: () => actionFailure(requestId),
      onSuccess: (value) => actionSuccess(requestId, value)
    })
  )

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
    const loadBlob = (blob: ReadClient.CodeCommitBlobMetadata | null) =>
      blob === null
        ? Effect.succeed(new Uint8Array())
        : client.getBlob({
          account: request.account,
          repositoryName: request.repositoryName,
          blobId: blob.blobId
        }).pipe(Effect.map(({ bytes }) => bytes))
    const [beforeBytes, afterBytes] = yield* Effect.all(
      [loadBlob(request.file.before), loadBlob(request.file.after)],
      { concurrency: 2 }
    )
    const path = changedFilePath(request.file)
    const identity = fileDiffIdentity(request.identity, request.revision, request.file)
    const disposition = blobPreviewDisposition(beforeBytes, afterBytes)
    if (disposition === "binary") {
      return {
        binary: true,
        diff: "",
        filetype: undefined,
        identity,
        metadata: null,
        path,
        truncated: false
      } satisfies RenderedFileDiff
    }
    if (disposition === "too-large") {
      return {
        binary: false,
        diff: "",
        filetype: filetypeForPath(path),
        identity,
        metadata: null,
        path,
        truncated: true
      } satisfies RenderedFileDiff
    }
    const [beforeText, afterText] = yield* Effect.all(
      [decodeBlob(beforeBytes), decodeBlob(afterBytes)],
      { concurrency: 2 }
    )
    const rendered = buildUnifiedDiff(request.file, beforeText, afterText)
    return {
      binary: false,
      diff: rendered.diff,
      filetype: filetypeForPath(path),
      identity,
      metadata: rendered.metadata,
      path,
      truncated: rendered.truncated
    } satisfies RenderedFileDiff
  }).pipe(Effect.withSpan("loadFileDiff", { attributes: { path: changedFilePath(request.file) } }))
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
        pullRequestId: input.pr.id,
        repositoryName: input.pr.repositoryName,
        sourceCommit: input.revision.sourceCommit
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
