import * as Schema from "effect/Schema"

import {
  BASE_RETRY_SOURCE,
  type CodeCommitGitFixtureRevisions,
  REVISION_ONE_RETRY_SOURCE,
  REVISION_TWO_RETRY_SOURCE,
  REVISION_TWO_TEST_SOURCE
} from "./GitFixture.js"

export const MockBlob = Schema.Struct({
  blobId: Schema.String.check(Schema.isNonEmpty()),
  content: Schema.String
})
export type MockBlob = typeof MockBlob.Type

export const MockChangedFile = Schema.Struct({
  path: Schema.String.check(Schema.isNonEmpty()),
  before: Schema.optional(MockBlob),
  after: Schema.optional(MockBlob)
}).check(
  Schema.makeFilter((file) => file.before !== undefined || file.after !== undefined, {
    identifier: "MockChangedFileHasContent",
    description: "a changed file must have a before or after blob"
  })
)
export type MockChangedFile = typeof MockChangedFile.Type

export const MockPullRequestRevision = Schema.Struct({
  revisionId: Schema.String.check(Schema.isNonEmpty()),
  sourceCommit: Schema.String.check(Schema.isNonEmpty()),
  destinationCommit: Schema.String.check(Schema.isNonEmpty()),
  mergeBase: Schema.String.check(Schema.isNonEmpty()),
  activityEpochSeconds: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  files: Schema.Array(MockChangedFile)
})
export type MockPullRequestRevision = typeof MockPullRequestRevision.Type

export const MockPullRequest = Schema.Struct({
  pullRequestId: Schema.String.check(Schema.isNonEmpty()),
  title: Schema.String.check(Schema.isNonEmpty()),
  description: Schema.String,
  authorArn: Schema.String.check(Schema.isNonEmpty()),
  sourceReference: Schema.String.check(Schema.isNonEmpty()),
  destinationReference: Schema.String.check(Schema.isNonEmpty()),
  status: Schema.Literals(["OPEN", "CLOSED"]),
  creationEpochSeconds: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  revisions: Schema.NonEmptyArray(MockPullRequestRevision)
})
export type MockPullRequest = typeof MockPullRequest.Type

export const MockRepository = Schema.Struct({
  repositoryName: Schema.String.check(Schema.isNonEmpty()),
  repositoryId: Schema.String.check(Schema.isNonEmpty()),
  description: Schema.String,
  defaultBranch: Schema.String.check(Schema.isNonEmpty()),
  pullRequests: Schema.Array(MockPullRequest)
})
export type MockRepository = typeof MockRepository.Type

export const CodeCommitMockScenario = Schema.Struct({
  accountId: Schema.String.check(Schema.isPattern(/^\d{12}$/u)),
  region: Schema.String.check(Schema.isNonEmpty()),
  callerArn: Schema.String.check(Schema.isNonEmpty()),
  repositories: Schema.NonEmptyArray(MockRepository)
})
export type CodeCommitMockScenario = typeof CodeCommitMockScenario.Type

/** Build the CLI scenario from Git objects that the local fixture can serve. */
export const makeGitFixtureScenario = (
  revisions: CodeCommitGitFixtureRevisions
): CodeCommitMockScenario =>
  Schema.decodeUnknownSync(CodeCommitMockScenario)({
    accountId: "123456789012",
    region: "eu-west-1",
    callerArn: "arn:aws:sts::123456789012:assumed-role/Reviewer/andrey",
    repositories: [{
      repositoryName: "payments-api",
      repositoryId: "11111111-1111-4111-8111-111111111111",
      description: "Example payments service",
      defaultBranch: "main",
      pullRequests: [{
        pullRequestId: "17",
        title: "Preserve idempotency keys across retries",
        description: "Moves request identity into the retry boundary and adds focused coverage.",
        authorArn: "arn:aws:sts::123456789012:assumed-role/Developer/alice",
        sourceReference: "refs/heads/feature/idempotency",
        destinationReference: "refs/heads/main",
        status: "OPEN",
        creationEpochSeconds: 1_787_728_400,
        revisions: [{
          revisionId: "revision-1",
          sourceCommit: revisions.firstHead,
          destinationCommit: revisions.base,
          mergeBase: revisions.base,
          activityEpochSeconds: 1_787_732_000,
          files: [{
            path: "src/retry.ts",
            before: { blobId: revisions.baseRetryBlob, content: BASE_RETRY_SOURCE },
            after: { blobId: revisions.firstRetryBlob, content: REVISION_ONE_RETRY_SOURCE }
          }, {
            path: "test/retry.test.ts",
            after: { blobId: revisions.firstTestBlob, content: REVISION_TWO_TEST_SOURCE }
          }]
        }, {
          revisionId: "revision-2",
          sourceCommit: revisions.secondHead,
          destinationCommit: revisions.base,
          mergeBase: revisions.base,
          activityEpochSeconds: 1_787_735_600,
          files: [{
            path: "src/retry.ts",
            before: { blobId: revisions.baseRetryBlob, content: BASE_RETRY_SOURCE },
            after: { blobId: revisions.secondRetryBlob, content: REVISION_TWO_RETRY_SOURCE }
          }, {
            path: "test/retry.test.ts",
            after: { blobId: revisions.secondTestBlob, content: REVISION_TWO_TEST_SOURCE }
          }]
        }]
      }]
    }]
  })

/** Small but multi-revision scenario used by the dev runner and integration tests. */
export const defaultScenario = Schema.decodeUnknownSync(CodeCommitMockScenario)({
  accountId: "123456789012",
  region: "eu-west-1",
  callerArn: "arn:aws:sts::123456789012:assumed-role/Reviewer/andrey",
  repositories: [{
    repositoryName: "payments-api",
    repositoryId: "11111111-1111-4111-8111-111111111111",
    description: "Example payments service",
    defaultBranch: "main",
    pullRequests: [{
      pullRequestId: "17",
      title: "Preserve idempotency keys across retries",
      description: "Moves request identity into the retry boundary and adds focused coverage.",
      authorArn: "arn:aws:sts::123456789012:assumed-role/Developer/alice",
      sourceReference: "refs/heads/feature/idempotency",
      destinationReference: "refs/heads/main",
      status: "OPEN",
      creationEpochSeconds: 1_787_728_400,
      revisions: [{
        revisionId: "revision-1",
        sourceCommit: "1111111111111111111111111111111111111111",
        destinationCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        mergeBase: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        activityEpochSeconds: 1_787_732_000,
        files: [{
          path: "src/retry.ts",
          before: {
            blobId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
            content: "export const retry = (run: () => Promise<void>) => run()\n"
          },
          after: {
            blobId: "111111111111111111111111111111111111111a",
            content: "export const retry = (key: string, run: () => Promise<void>) => run()\n"
          }
        }]
      }, {
        revisionId: "revision-2",
        sourceCommit: "2222222222222222222222222222222222222222",
        destinationCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        mergeBase: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        activityEpochSeconds: 1_787_735_600,
        files: [{
          path: "src/retry.ts",
          before: {
            blobId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
            content: "export const retry = (run: () => Promise<void>) => run()\n"
          },
          after: {
            blobId: "222222222222222222222222222222222222222a",
            content:
              "export const retry = async (key: string, run: () => Promise<void>) => {\n  await persist(key)\n  return run()\n}\n"
          }
        }, {
          path: "test/retry.test.ts",
          after: {
            blobId: "222222222222222222222222222222222222222b",
            content: "it('reuses the key', async () => {})\n"
          }
        }]
      }]
    }]
  }]
})
