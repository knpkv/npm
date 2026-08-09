import { AwsClient, type Domain, ReadClient, ReviewClient } from "@knpkv/codecommit-core"
import { Crypto, Effect, Stream } from "effect"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import {
  relayFindingCommentContent,
  relayFindingDescriptionContent,
  relayFindingFileIndex,
  relayFindingPublicationOptions,
  type RelayReviewConversationTurn,
  type RelayReviewFinding,
  type RelayReviewKind,
  type RelayReviewResult,
  runRelayReview,
  runRelayReviewConversation,
  runRelayReviewVerification
} from "../../RelayReview.js"
import type { RelayReviewSkillId } from "../../ReviewSkills.js"
import { WorktreeError, type WorktreePlan, type WorktreeResult, WorktreeService } from "../../WorktreeService.js"
import {
  type ActionDiagnostic,
  actionDiagnostic,
  actionOutcome,
  changedFilePath,
  fileDiffIdentity,
  type PullRequestWorkspaceIdentity,
  pullRequestWorkspaceIdentity
} from "../details-model.js"
import { type OpenEditorInput, openLocalEditor } from "../editor-launch.js"
import {
  type FileDiffOutcome,
  type FileDiffRequest,
  loadFileDiff,
  loadLocalGitBlob,
  preloadLocalFileDiffs
} from "../file-diff.js"
import { runtimeAtom } from "./runtime.js"

export interface PullRequestWorkspace {
  readonly fileDiffs: ReadonlyMap<string, FileDiffOutcome>
  readonly identity: PullRequestWorkspaceIdentity
  readonly revision: ReadClient.CodeCommitPullRequestRevision
  readonly files: ReadonlyArray<ReadClient.CodeCommitChangedFile>
  readonly localDiff:
    | {
      readonly _tag: "ready"
      readonly plan: WorktreePlan
      readonly worktree: WorktreeResult
    }
    | { readonly _tag: "unavailable"; readonly diagnostic: ActionDiagnostic }
}

type LocalDiffReady = Extract<PullRequestWorkspace["localDiff"], { readonly _tag: "ready" }>

export interface RelayReviewActionInput {
  readonly kind: RelayReviewKind
  readonly plan: WorktreePlan
  readonly requestId: string
  readonly revision: ReadClient.CodeCommitPullRequestRevision
  readonly skills: ReadonlyArray<RelayReviewSkillId>
}

export interface RelayReviewConversationActionInput extends RelayReviewActionInput {
  readonly currentReview: RelayReviewResult
  readonly findingId: string
  readonly message: string
  readonly turns: ReadonlyArray<RelayReviewConversationTurn>
}

export interface VerifyRelayFindingActionInput {
  readonly currentReview: RelayReviewResult
  readonly findingId: string
  readonly kind: RelayReviewKind
  readonly previousRevision: ReadClient.CodeCommitPullRequestRevision
  readonly pr: Domain.PullRequest
  readonly requestId: string
  readonly skills: ReadonlyArray<RelayReviewSkillId>
  readonly turns: ReadonlyArray<RelayReviewConversationTurn>
}

export interface WorktreeActionInput {
  readonly plan: WorktreePlan
  readonly requestId: string
}

export interface PostRelayFindingInput {
  readonly files: ReadonlyArray<ReadClient.CodeCommitChangedFile>
  readonly finding: RelayReviewFinding
  readonly findingIndex: number
  readonly pr: Domain.PullRequest
  readonly requestId: string
  readonly revision: ReadClient.CodeCommitPullRequestRevision
}

export const loadPullRequestWorkspaceAtom = runtimeAtom.fn((pr: Domain.PullRequest) =>
  Effect.gen(function*() {
    const client = yield* ReadClient.CodeCommitReadClient
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const worktreeService = yield* WorktreeService
    const account = { profile: pr.account.profile, region: pr.account.region }
    const revision = yield* client.getPullRequest({ account, pullRequestId: pr.id })
    const localDiff = yield* worktreeService.preflight({
      account: pr.account,
      destinationCommit: revision.destinationCommit,
      destinationReference: pr.destinationBranch,
      pullRequestId: pr.id,
      repositoryName: pr.repositoryName,
      sourceCommit: revision.sourceCommit,
      sourceReference: pr.sourceBranch
    }).pipe(
      Effect.flatMap((plan) =>
        worktreeService.checkout(plan).pipe(
          Effect.map((worktree): LocalDiffReady => ({ _tag: "ready", plan, worktree }))
        )
      ),
      Effect.match({
        onFailure: (error): PullRequestWorkspace["localDiff"] => ({
          _tag: "unavailable",
          diagnostic: actionDiagnostic(error)
        }),
        onSuccess: (ready) => ready
      })
    )
    const files = yield* client.streamChangedFiles({
      account,
      repositoryName: revision.repositoryName,
      beforeCommitSpecifier: revision.destinationCommit,
      afterCommitSpecifier: revision.sourceCommit
    }).pipe(Stream.runCollect)
    const fileArray = Array.from(files)
    const fileDiffs = localDiff._tag === "ready"
      ? yield* preloadLocalFileDiffs(
        {
          getBlob: client.getBlob,
          getLocalBlob: (request) => loadLocalGitBlob(spawner, request)
        },
        {
          account: pr.account,
          files: fileArray,
          identity: pullRequestWorkspaceIdentity(pr),
          localWorktreePath: localDiff.worktree.path,
          repositoryName: revision.repositoryName,
          revision
        }
      )
      : new Map<string, FileDiffOutcome>()
    return {
      fileDiffs,
      identity: pullRequestWorkspaceIdentity(pr),
      revision,
      files: fileArray,
      localDiff
    } satisfies PullRequestWorkspace
  }).pipe(Effect.withSpan("loadPullRequestWorkspace", { attributes: { prId: pr.id } }))
)

export const loadFileDiffAtom = runtimeAtom.fn((request: FileDiffRequest) =>
  Effect.gen(function*() {
    const client = yield* ReadClient.CodeCommitReadClient
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const identity = fileDiffIdentity(request.identity, request.revision, request.file)
    return yield* loadFileDiff({
      getBlob: client.getBlob,
      getLocalBlob: (localRequest) => loadLocalGitBlob(spawner, localRequest)
    }, request).pipe(
      Effect.match({
        onFailure: (): FileDiffOutcome => ({ _tag: "failure", identity }),
        onSuccess: (value): FileDiffOutcome => ({ _tag: "success", identity, value })
      })
    )
  }).pipe(Effect.withSpan("loadFileDiffAtom", { attributes: { path: changedFilePath(request.file) } }))
)

export const openEditorAtom = runtimeAtom.fn((input: OpenEditorInput) =>
  actionOutcome(input.requestId, openLocalEditor(input)).pipe(
    Effect.withSpan("openEditor", { attributes: { editor: input.editor, path: input.filePath } })
  )
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
          skills: input.skills,
          worktreePath: worktree.path
        })
        return { kind: input.kind, summary, worktree }
      })
    )
  }).pipe(Effect.withSpan("runRelayReview", { attributes: { kind: input.kind } }))
)

export const continueRelayReviewAtom = runtimeAtom.fn((input: RelayReviewConversationActionInput) =>
  Effect.gen(function*() {
    const service = yield* WorktreeService
    return yield* actionOutcome(
      input.requestId,
      Effect.gen(function*() {
        const worktree = yield* service.checkout(input.plan)
        const response = yield* runRelayReviewConversation({
          baseCommit: input.revision.destinationCommit,
          currentReview: input.currentReview,
          headCommit: input.revision.sourceCommit,
          kind: input.kind,
          message: input.message,
          pullRequestId: input.revision.pullRequestId,
          repositoryName: input.revision.repositoryName,
          selectedFindingId: input.findingId,
          skills: input.skills,
          turns: input.turns,
          worktreePath: worktree.path
        })
        return { findingId: input.findingId, response, worktree }
      })
    )
  }).pipe(Effect.withSpan("continueRelayReview", { attributes: { findingId: input.findingId } }))
)

/** Refreshes the provider head and verifies one finding against a new exact local checkout. */
export const verifyRelayFindingAtom = runtimeAtom.fn((input: VerifyRelayFindingActionInput) =>
  Effect.gen(function*() {
    const client = yield* ReadClient.CodeCommitReadClient
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const service = yield* WorktreeService
    return yield* actionOutcome(
      input.requestId,
      Effect.gen(function*() {
        const account = { profile: input.pr.account.profile, region: input.pr.account.region }
        const revision = yield* client.getPullRequest({
          account,
          pullRequestId: input.pr.id
        }).pipe(
          Effect.mapError((cause) =>
            new WorktreeError({
              operation: "verify-finding-revision",
              message: "Unable to refresh the pull request's latest revision",
              cause
            })
          )
        )
        const plan = yield* service.preflight({
          account: input.pr.account,
          destinationCommit: revision.destinationCommit,
          destinationReference: input.pr.destinationBranch,
          pullRequestId: input.pr.id,
          repositoryName: input.pr.repositoryName,
          sourceCommit: revision.sourceCommit,
          sourceReference: input.pr.sourceBranch
        })
        const worktree = yield* service.checkout(plan)
        const files = yield* client.streamChangedFiles({
          account,
          repositoryName: revision.repositoryName,
          beforeCommitSpecifier: revision.destinationCommit,
          afterCommitSpecifier: revision.sourceCommit
        }).pipe(
          Stream.runCollect,
          Effect.mapError((cause) =>
            new WorktreeError({
              operation: "verify-finding-files",
              message: "Unable to load the latest changed files for verification",
              cause
            })
          )
        )
        const response = yield* runRelayReviewVerification({
          baseCommit: revision.destinationCommit,
          currentReview: input.currentReview,
          headCommit: revision.sourceCommit,
          kind: input.kind,
          previousBaseCommit: input.previousRevision.destinationCommit,
          previousHeadCommit: input.previousRevision.sourceCommit,
          pullRequestId: revision.pullRequestId,
          repositoryName: revision.repositoryName,
          selectedFindingId: input.findingId,
          skills: input.skills,
          turns: input.turns,
          worktreePath: worktree.path
        })
        const fileArray = Array.from(files)
        const identity = pullRequestWorkspaceIdentity(input.pr)
        const fileDiffs = yield* preloadLocalFileDiffs(
          {
            getBlob: client.getBlob,
            getLocalBlob: (request) => loadLocalGitBlob(spawner, request)
          },
          {
            account: input.pr.account,
            files: fileArray,
            identity,
            localWorktreePath: worktree.path,
            repositoryName: revision.repositoryName,
            revision
          }
        )
        const workspace: PullRequestWorkspace = {
          fileDiffs,
          identity,
          revision,
          files: fileArray,
          localDiff: { _tag: "ready", plan, worktree }
        }
        return { findingId: input.findingId, plan, response, workspace }
      })
    )
  }).pipe(Effect.withSpan("verifyRelayFinding", { attributes: { findingId: input.findingId } }))
)

const textEncoder = new TextEncoder()

const reviewPostingMessage = (error: ReviewClient.CodeCommitReviewError): string => {
  switch (error._tag) {
    case "CodeCommitReviewConflictError":
      return `The finding was not posted because the pull-request target changed (${error.reason})`
    case "AwsCredentialError":
      return "AWS credentials could not be acquired for the finding post"
    case "AwsThrottleError":
      return "CodeCommit throttled the finding post"
    case "AwsApiError":
      return "CodeCommit rejected the finding post"
    case "CodeCommitBlobTooLargeError":
    case "CodeCommitMalformedResponseError":
    case "CodeCommitReadNotFoundError":
      return "The exact pull-request target could not be verified for the finding post"
  }
}

/** Posts one explicitly accepted Relay finding after an immutable-revision preflight. */
export const postRelayFindingAtom = runtimeAtom.fn((input: PostRelayFindingInput) =>
  actionOutcome(
    input.requestId,
    Effect.gen(function*() {
      const client = yield* ReviewClient.CodeCommitReviewClient
      const awsClient = yield* AwsClient.AwsClient
      const readClient = yield* ReadClient.CodeCommitReadClient
      const cryptoService = yield* Crypto.Crypto
      const fileIndex = relayFindingFileIndex(input.finding, input.files)
      if (!relayFindingPublicationOptions(input.finding).includes(input.finding.publicationTarget)) {
        return yield* new WorktreeError({
          operation: "post-finding",
          message: "The selected publication target is incompatible with the finding's evidence anchor"
        })
      }
      if (input.finding.location.scope !== "general" && fileIndex === null) {
        return yield* new WorktreeError({
          operation: "post-finding",
          message: "The finding anchor does not belong to this exact pull-request revision"
        })
      }
      const canonicalIdentity = [
        input.pr.account.profile,
        input.pr.account.region,
        input.revision.repositoryName,
        input.revision.pullRequestId,
        input.revision.revisionId,
        input.revision.destinationCommit,
        input.revision.sourceCommit,
        String(input.findingIndex),
        input.finding.id,
        input.finding.priority,
        input.finding.title,
        input.finding.summary,
        input.finding.details,
        input.finding.recommendation,
        input.finding.verification,
        input.finding.publicationTarget,
        JSON.stringify(input.finding.location)
      ].join("\u0000")
      const digest = yield* cryptoService.digest("SHA-256", textEncoder.encode(canonicalIdentity)).pipe(
        Effect.mapError((cause) =>
          new WorktreeError({
            operation: "post-finding-token",
            message: "Unable to derive the finding idempotency token",
            cause
          })
        )
      )
      const clientRequestToken = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
      if (input.finding.publicationTarget === "description") {
        const exact = yield* readClient.getPullRequest({
          account: { profile: input.pr.account.profile, region: input.pr.account.region },
          pullRequestId: input.revision.pullRequestId
        }).pipe(
          Effect.mapError((cause) =>
            new WorktreeError({
              operation: "post-finding-description-preflight",
              message: "The exact pull-request target could not be verified before updating its description",
              cause
            })
          )
        )
        if (
          exact.revisionId !== input.revision.revisionId ||
          exact.sourceCommit !== input.revision.sourceCommit ||
          exact.destinationCommit !== input.revision.destinationCommit
        ) {
          return yield* new WorktreeError({
            operation: "post-finding-description",
            message: "The finding was not added because the pull-request revision changed"
          })
        }
        const marker = `<!-- relay-finding:${clientRequestToken} -->`
        const currentDescription = exact.description?.trim() ?? ""
        if (!currentDescription.includes(marker)) {
          const fragment = `${marker}\n${relayFindingDescriptionContent(input.finding)}`
          const description = currentDescription.length === 0
            ? fragment
            : `${currentDescription}\n\n---\n\n${fragment}`
          if (textEncoder.encode(description).byteLength > 10_100) {
            return yield* new WorktreeError({
              operation: "post-finding-description",
              message: "The updated pull-request description would exceed the safe 10,100-byte limit"
            })
          }
          yield* awsClient.updatePullRequestDescription({
            account: { profile: input.pr.account.profile, region: input.pr.account.region },
            description,
            pullRequestId: input.revision.pullRequestId
          }).pipe(
            Effect.mapError((cause) =>
              new WorktreeError({
                operation: "post-finding-description",
                message: "CodeCommit rejected the pull-request description update",
                cause
              })
            )
          )
        }
        return {
          findingId: input.finding.id,
          findingIndex: input.findingIndex,
          target: input.finding.publicationTarget
        }
      }
      const location = input.finding.publicationTarget === "line-comment" && input.finding.location.scope === "line"
        ? new ReviewClient.CodeCommitReviewLocation({
          filePath: input.finding.location.filePath,
          filePosition: input.finding.location.line,
          relativeFileVersion: input.finding.location.side === "after" ? "AFTER" : "BEFORE"
        })
        : undefined
      return yield* client.execute({
        _tag: "comment",
        target: {
          account: { profile: input.pr.account.profile, region: input.pr.account.region },
          repositoryName: input.revision.repositoryName,
          pullRequestId: input.revision.pullRequestId,
          revisionId: input.revision.revisionId,
          sourceCommit: input.revision.sourceCommit,
          destinationCommit: input.revision.destinationCommit,
          destinationReference: input.revision.destinationReference
        },
        content: relayFindingCommentContent(input.finding),
        clientRequestToken,
        ...(location === undefined ? {} : { location })
      }).pipe(
        Effect.map((receipt) => ({
          findingId: input.finding.id,
          findingIndex: input.findingIndex,
          receipt,
          target: input.finding.publicationTarget
        })),
        Effect.mapError((cause) =>
          new WorktreeError({
            operation: "post-finding",
            message: reviewPostingMessage(cause),
            cause
          })
        )
      )
    })
  ).pipe(Effect.withSpan("postRelayFinding", { attributes: { findingIndex: input.findingIndex } }))
)
