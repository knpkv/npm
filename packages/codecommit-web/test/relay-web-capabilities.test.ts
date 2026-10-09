import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { describeCall, invoke } from "@knpkv/capability"
import { CacheService, Domain, Errors, PRService, ReadClient, ReviewClient } from "@knpkv/codecommit-core"
import { Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { postLineComment, webCapabilities } from "../src/server/relay/RelayWebCapabilities.js"
import { RelayFindingPublisher } from "../src/server/review/RelayFindingPublisher.js"

const pullRequest = new Domain.PullRequest({
  account: new Domain.Account({
    profile: Domain.AwsProfileName.make("production"),
    region: Domain.AwsRegion.make("eu-west-1"),
    awsAccountId: "111122223333"
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

const coordinates = { accountId: "111122223333", region: "eu-west-1", repositoryName: "payments", pullRequestId: "42" }

const revision = new ReadClient.CodeCommitPullRequestRevision({
  authorArn: null,
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

const seenRevision = { revisionId: "revision-1", baseCommit: "a".repeat(40), headCommit: "b".repeat(40) }

// One modified file whose single line changed: line 1 exists on both sides of the patch.
const changedFile = new ReadClient.CodeCommitChangedFile({
  before: new ReadClient.CodeCommitBlobMetadata({
    blobId: ReadClient.CodeCommitBlobId.make("d".repeat(40)),
    mode: "100644",
    path: "src/patch-reader.ts"
  }),
  after: new ReadClient.CodeCommitBlobMetadata({
    blobId: ReadClient.CodeCommitBlobId.make("c".repeat(40)),
    mode: "100644",
    path: "src/patch-reader.ts"
  }),
  status: "modified"
})

const unused = <A>(): Effect.Effect<A> => Effect.die("unused read-client operation")

const readClient = (current: ReadClient.CodeCommitPullRequestRevision): ReadClient.CodeCommitReadClientService => ({
  discoverAccount: () => unused(),
  getBlob: ({ blobId }) =>
    Effect.succeed(
      new ReadClient.CodeCommitBlobContent({
        blobId: ReadClient.CodeCommitBlobId.make(blobId),
        bytes: new TextEncoder().encode(blobId === changedFile.before?.blobId ? "before\n" : "after\n")
      })
    ),
  getChangedFilesPage: () => unused(),
  getPullRequest: () => Effect.succeed(current),
  getRepositoryIdentity: () => unused(),
  listPullRequestIdsPage: () => unused(),
  listPullRequestsPage: () => unused(),
  listRepositoriesPage: () => unused(),
  streamChangedFiles: () => Stream.make(changedFile),
  streamPullRequests: () => Stream.empty
})

const posted: Array<Extract<ReviewClient.CodeCommitReviewAction, { readonly _tag: "comment" }>> = []

const services = (
  current: ReadClient.CodeCommitPullRequestRevision,
  post?: RelayFindingPublisher["Service"]["post"]
) =>
  Layer.mergeAll(
    Layer.mock(CacheService.PullRequestRepo, {
      findByCoordinates: () =>
        Effect.succeed(Option.some(Schema.encodeSync(PRService.CachedPRToPullRequest)(pullRequest)))
    }),
    Layer.succeed(ReadClient.CodeCommitReadClient, readClient(current)),
    Layer.succeed(RelayFindingPublisher, {
      post: post ?? ((action) =>
        Effect.sync(() => {
          posted.push(action)
          return new ReviewClient.CodeCommitReviewReceipt({ operationId: "comment:9", summary: "Comment posted" })
        }))
    }),
    NodeServices.layer
  )

const lineComment = (line: number) => ({
  pullRequest: coordinates,
  revision: seenRevision,
  location: { filePath: "src/patch-reader.ts", line, side: "after" },
  content: "Check for null before reading the field."
})

layer(services(revision))("CodeCommit web Relay capabilities", (it) => {
  it.effect("lists the changed files of the revision it read", () =>
    Effect.gen(function*() {
      const result = yield* invoke(webCapabilities.getPullRequestDiff, { pullRequest: coordinates })
      expect(result.output).toEqual({
        pullRequest: coordinates,
        revision: seenRevision,
        files: [{ status: "modified", path: "src/patch-reader.ts", previousPath: null }],
        total: 1
      })
    }))

  it.effect("shows the person the exact file, side, line, revision and text before posting", () =>
    Effect.gen(function*() {
      const action = yield* describeCall(postLineComment, lineComment(1))
      expect(action).toEqual({
        verb: "post line comment",
        target: { product: "codecommit", kind: "pull-request", id: "111122223333/eu-west-1/payments/42" },
        args: {
          content: "Check for null before reading the field.",
          location: { filePath: "src/patch-reader.ts", line: 1, side: "after" },
          revision: seenRevision
        }
      })
    }))

  it.effect("posts on the line the person saw, pinned to that revision", () =>
    Effect.gen(function*() {
      posted.length = 0
      const result = yield* invoke(webCapabilities.postLineComment, lineComment(1))
      expect(result.output).toMatchObject({ operationId: "comment:9" })
      expect(posted).toHaveLength(1)
      expect(posted[0]).toMatchObject({
        content: "Check for null before reading the field.",
        target: { revisionId: "revision-1", sourceCommit: "b".repeat(40) },
        location: { filePath: "src/patch-reader.ts", filePosition: 1, relativeFileVersion: "AFTER" }
      })
      expect(posted[0]?.clientRequestToken).toMatch(/^[0-9a-f]{64}$/u)
    }))

  it.effect("refuses a line outside the changes instead of posting it elsewhere", () =>
    Effect.gen(function*() {
      posted.length = 0
      const exit = yield* Effect.exit(invoke(webCapabilities.postLineComment, lineComment(50)))
      expect(exit).toMatchObject(Exit.fail({ _tag: "CapabilityFailed", tag: "CommentLineOutsidePatch" }))
      expect(posted).toEqual([])
    }))
})

layer(services(new ReadClient.CodeCommitPullRequestRevision({ ...revision, revisionId: "revision-2" })))(
  "when the pull request moved on",
  (it) => {
    it.effect("refuses to post against the older head and says how to recover", () =>
      Effect.gen(function*() {
        posted.length = 0
        const exit = yield* Effect.exit(invoke(webCapabilities.postLineComment, lineComment(1)))
        expect(exit).toMatchObject(Exit.fail({ _tag: "CapabilityFailed", tag: "ReviewHeadMoved" }))
        expect(JSON.stringify(exit)).toContain("current head")
        expect(posted).toEqual([])
      }))
  }
)

const refusedBy = (reason: "denied" | "timeout") => () =>
  Effect.fail(
    new Errors.AwsApiError({
      operation: "postPullRequestComment",
      profile: Domain.AwsProfileName.make("production"),
      region: Domain.AwsRegion.make("eu-west-1"),
      cause: new Errors.PermissionDeniedError({ operation: "postPullRequestComment", reason })
    })
  )

layer(services(revision, refusedBy("denied")))("when the person's permission settings refuse the comment", (it) => {
  it.effect("reports it as not permitted, never as something to try again", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(invoke(webCapabilities.postLineComment, lineComment(1)))
      expect(exit).toMatchObject(Exit.fail({ _tag: "CapabilityFailed", tag: "CommentNotPermitted" }))
      expect(JSON.stringify(exit)).toContain("Do not retry")
      expect(JSON.stringify(exit)).not.toContain("Try again")
    }))
})

layer(services(revision, refusedBy("timeout")))("when nobody answers the permission prompt", (it) => {
  it.effect("says the prompt went unanswered, still not as something to try again", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(invoke(webCapabilities.postLineComment, lineComment(1)))
      expect(exit).toMatchObject(Exit.fail({ _tag: "CapabilityFailed", tag: "CommentNotPermitted" }))
      expect(JSON.stringify(exit)).toContain("Nobody answered the permission prompt")
    }))
})
