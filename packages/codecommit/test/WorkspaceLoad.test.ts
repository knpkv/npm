import { describe, expect, it } from "@effect/vitest"
import { Domain, ReadClient } from "@knpkv/codecommit-core"
import { Effect, Layer, Stream } from "effect"
import {
  loadPullRequestRevision,
  loadPullRequestWorkspace,
  localDiffForWorkspace,
  localWorktreePathForDiff,
  providerRevisionChanged
} from "../src/tui/workspace.js"

const pullRequest = new Domain.PullRequest({
  account: new Domain.Account({
    profile: Domain.AwsProfileName.make("production"),
    region: Domain.AwsRegion.make("eu-west-1"),
    repoAccountId: "111122223333"
  }),
  approvalRules: [],
  approvedBy: [],
  approvedByArns: [],
  author: "reviewer",
  commentedBy: [],
  creationDate: new Date(0),
  destinationBranch: "main",
  id: Domain.PullRequestId.make("42"),
  isApproved: false,
  isMergeable: true,
  lastModifiedDate: new Date(1_000),
  link: "https://example.invalid/pr/42",
  repositoryName: Domain.RepositoryName.make("payments"),
  sourceBranch: "feature",
  status: "OPEN",
  title: "Review"
})

const revision = new ReadClient.CodeCommitPullRequestRevision({
  authorArn: "arn:aws:iam::111122223333:user/reviewer",
  creationDate: new Date(0),
  destinationCommit: ReadClient.CodeCommitCommitId.make("a".repeat(40)),
  destinationReference: "refs/heads/main",
  lastActivityDate: new Date(1_000),
  mergeBase: ReadClient.CodeCommitCommitId.make("a".repeat(40)),
  pullRequestId: pullRequest.id,
  repositoryName: pullRequest.repositoryName,
  revisionId: "revision-1",
  sourceCommit: ReadClient.CodeCommitCommitId.make("b".repeat(40)),
  sourceReference: "refs/heads/feature",
  status: "OPEN",
  title: pullRequest.title
})

const changedFile = new ReadClient.CodeCommitChangedFile({
  after: new ReadClient.CodeCommitBlobMetadata({
    blobId: ReadClient.CodeCommitBlobId.make("c".repeat(40)),
    mode: "100644",
    path: "src/index.ts"
  }),
  before: new ReadClient.CodeCommitBlobMetadata({
    blobId: ReadClient.CodeCommitBlobId.make("d".repeat(40)),
    mode: "100644",
    path: "src/index.ts"
  }),
  status: "modified"
})

describe("pull request workspace loading", () => {
  it.effect("opens with provider data without requiring Git or a WorktreeService", () =>
    Effect.gen(function*() {
      const workspace = yield* loadPullRequestWorkspace(pullRequest)

      expect(workspace.revision).toBe(revision)
      expect(workspace.files).toEqual([changedFile])
      expect(workspace.fileDiffs.size).toBe(0)
      expect(workspace.localDiff).toEqual({ _tag: "provider" })
    }).pipe(
      Effect.provide(
        Layer.mock(ReadClient.CodeCommitReadClient, {
          getPullRequest: () => Effect.succeed(revision),
          streamChangedFiles: () => Stream.make(changedFile)
        })
      )
    ))

  it.effect("checks for a newer provider head without loading files or invoking Git", () =>
    Effect.gen(function*() {
      const observation = yield* loadPullRequestRevision(pullRequest)

      expect(observation.identity.pullRequestId).toBe(pullRequest.id)
      expect(observation.revision).toBe(revision)
    }).pipe(
      Effect.provide(
        Layer.mock(ReadClient.CodeCommitReadClient, {
          getPullRequest: () => Effect.succeed(revision)
        })
      )
    ))

  it("uses a retained checkout only for its exact revision and marks a newer provider head outdated", () => {
    const plan = {
      account: pullRequest.account,
      cachePath: "/tmp/cache.git",
      destinationCommit: revision.destinationCommit,
      destinationReference: pullRequest.destinationBranch,
      pullRequestId: pullRequest.id,
      repositoryName: pullRequest.repositoryName,
      sourceCommit: revision.sourceCommit,
      sourceReference: pullRequest.sourceBranch,
      targetExists: true,
      targetPath: "/tmp/worktree"
    }
    const checkout = {
      identity: {
        profile: pullRequest.account.profile,
        pullRequestId: pullRequest.id,
        region: pullRequest.account.region,
        repositoryName: pullRequest.repositoryName
      },
      plan,
      worktree: { path: plan.targetPath, reused: true, sourceCommit: revision.sourceCommit }
    }

    expect(localDiffForWorkspace(checkout.identity, revision, null)).toEqual({ _tag: "provider" })
    expect(
      localDiffForWorkspace(
        { ...checkout.identity, pullRequestId: Domain.PullRequestId.make("43") },
        revision,
        checkout
      )
    ).toEqual({ _tag: "provider" })
    const ready = localDiffForWorkspace(checkout.identity, revision, checkout)
    expect(ready).toEqual({
      _tag: "ready",
      plan,
      worktree: checkout.worktree
    })
    const newerRevision = new ReadClient.CodeCommitPullRequestRevision({
      ...revision,
      sourceCommit: ReadClient.CodeCommitCommitId.make("e".repeat(40))
    })
    const outdated = localDiffForWorkspace(checkout.identity, newerRevision, checkout)
    expect(outdated).toEqual({ _tag: "outdated", plan, worktree: checkout.worktree })
    expect(localWorktreePathForDiff(ready)).toBe(plan.targetPath)
    expect(localWorktreePathForDiff(outdated)).toBeUndefined()
    expect(localWorktreePathForDiff({ _tag: "provider" })).toBeUndefined()
    expect(providerRevisionChanged(revision, revision)).toBe(false)
    expect(providerRevisionChanged(revision, newerRevision)).toBe(true)
    expect(
      providerRevisionChanged(revision, {
        ...revision,
        destinationCommit: ReadClient.CodeCommitCommitId.make("f".repeat(40))
      })
    ).toBe(true)
  })
})
