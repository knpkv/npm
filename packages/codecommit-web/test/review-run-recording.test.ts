import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import {
  Account,
  AwsProfileName,
  AwsRegion,
  PullRequest,
  PullRequestId,
  RepositoryName
} from "@knpkv/codecommit-core/Domain.js"
import { ConfigProvider, Effect, FileSystem, Schema, Stream } from "effect"
import { PullRequestRelayReviewResponse, type RelayReviewStreamEvent } from "../src/server/Api.js"
import { reviewRunOfResponse } from "../src/server/review/review-run-projection.js"
import { ReviewRunStoreError } from "../src/server/review/ReviewRunReader.js"
import {
  makeReviewRunRecorder,
  recordCompletedReview,
  recordCompletedReviewStream
} from "../src/server/review/ReviewRunRecorder.js"

const pr = new PullRequest({
  account: new Account({
    profile: AwsProfileName.make("owner-profile"),
    region: AwsRegion.make("fixture-zone"),
    awsAccountId: "owner-account"
  }),
  approvalRules: [],
  approvedBy: [],
  approvedByArns: [],
  author: "Reviewer",
  commentedBy: [],
  creationDate: new Date(0),
  destinationBranch: "main",
  id: PullRequestId.make("35"),
  isApproved: false,
  isMergeable: true,
  lastModifiedDate: new Date(1_000),
  link: "https://example.invalid/pr/35",
  repositoryName: RepositoryName.make("review-repo"),
  sourceBranch: "feature",
  status: "OPEN",
  title: "Review persistence"
})
const response = Schema.decodeUnknownSync(PullRequestRelayReviewResponse)({
  pullRequestId: "35",
  revisionId: "revision-1",
  baseCommit: "base-1",
  headCommit: "head-1",
  kind: "review",
  profile: {
    id: "review",
    name: "Review",
    kind: "review",
    provider: "codex",
    harness: "native-codex",
    model: "configured-default",
    skillIds: []
  },
  result: {
    verdict: "Check the storage boundary",
    findings: [{
      id: "F1",
      priority: "P1",
      title: "History should not discard the result",
      summary: "Completed output is primary.",
      details: "A disk failure cannot turn completed output into an execution failure.",
      recommendation: "Retain the result with a warning.",
      verification: "Fail the history save.",
      publicationTarget: "pr-comment",
      location: { scope: "general" }
    }]
  }
})

it.effect("owner completion retains findings and a typed warning when saving history fails", () =>
  Effect.gen(function*() {
    for (
      const reason of ["io", "invalid", "oversized", "private_path"] satisfies ReadonlyArray<
        ReviewRunStoreError["reason"]
      >
    ) {
      const record = recordCompletedReview(() => Effect.fail(new ReviewRunStoreError({ operation: "save", reason })))
      const completed = yield* record(pr, response)
      expect(completed.result).toEqual(response.result)
      expect(completed.headCommit).toBe(response.headCommit)
      expect(completed.historyWarning).toEqual({ reason })
      expect(Schema.decodeUnknownResult(PullRequestRelayReviewResponse)(completed)._tag).toBe("Success")
    }
  }))

it.effect("streams keep their complete frame and warning instead of becoming an error", () =>
  Effect.gen(function*() {
    const record = recordCompletedReview(() =>
      Effect.fail(new ReviewRunStoreError({ operation: "save", reason: "io" }))
    )
    const progress: RelayReviewStreamEvent = { type: "progress", phase: "agent", message: "Reviewing" }
    const complete: RelayReviewStreamEvent = { type: "complete", review: response, reply: "Finding checked." }
    const events = yield* recordCompletedReviewStream(Stream.make(progress, complete), (review) => record(pr, review))
      .pipe(Stream.runCollect)
    expect(events).toEqual([progress, { ...complete, review: { ...response, historyWarning: { reason: "io" } } }])
  }))

it.effect("successful history saves leave completed output unchanged", () =>
  Effect.gen(function*() {
    const run = yield* reviewRunOfResponse("private-subject", response, "run-1", 1_000)
    const record = recordCompletedReview(() => Effect.succeed({ _tag: "Saved", run }))
    expect(yield* record(pr, response)).toEqual(response)
  }))

it.layer(NodeServices.layer)("recorder configuration", (it) => {
  it.effect("missing home leaves route construction usable and only warns on completed history", () =>
    Effect.gen(function*() {
      const save = yield* makeReviewRunRecorder().pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))
      )
      const completed = yield* recordCompletedReview(save)(pr, response)
      expect(completed.result).toEqual(response.result)
      expect(completed.historyWarning).toEqual({ reason: "private_path" })
    }))

  it.effect("a configured home still persists the completed result", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const save = yield* makeReviewRunRecorder().pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ HOME: home }))
      )
      const saved = yield* save(pr, response)
      expect(saved._tag).toBe("Saved")
      expect(saved.run.summary).toBe(response.result.verdict)
      expect((yield* fs.readDirectory(home + "/.codecommit/reviews")).length).toBe(1)
    }))
})
