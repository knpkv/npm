import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { describe, it } from "@effect/vitest"
import * as AwsClientConfig from "@knpkv/codecommit-core/AwsClientConfig.js"
import * as Domain from "@knpkv/codecommit-core/Domain.js"
import * as CodeCommit from "@knpkv/codecommit-core/ReadClient.js"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import {
  type CodePipelineExecutionPage,
  type CodePipelineExecutionSummary,
  CodePipelineReadClient
} from "../../src/server/plugins/codepipeline/CodePipelineReadClient.js"
import {
  assertLiveAwsProbe,
  findValueInBoundedPages,
  isExactLiveAwsFixtureDiff,
  isSuccessfulExecutionForPipelineVersion,
  matchesLiveAwsPipelineDefinition,
  resourceExistsInBoundedPages,
  sanitizeLiveAwsProbe
} from "./liveAwsProbeAssertions.js"

const RequiredText = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512)
)
const AwsRegion = RequiredText.check(
  Schema.isPattern(/^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/u, {
    expected: "an AWS region"
  })
)
const AwsRoleArn = RequiredText.check(
  Schema.isPattern(
    /^arn:(?:aws|aws-us-gov):iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]+$/u,
    { expected: "an IAM role ARN" }
  )
)
const LiveAwsProbeConfiguration = Schema.Struct({
  activation: Schema.Literal("1"),
  awsRegion: AwsRegion,
  codeCommitRepository: RequiredText,
  codePipelinePipeline: RequiredText,
  roleArn: AwsRoleArn
})

const REQUIRED_VARIABLES: ReadonlyArray<string> = [
  "CONTROL_CENTER_LIVE_AWS_PROBE",
  "CONTROL_CENTER_TEST_AWS_REGION",
  "CONTROL_CENTER_TEST_AWS_ROLE_ARN",
  "CONTROL_CENTER_TEST_CODECOMMIT_REPOSITORY",
  "CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE"
]

class LiveAwsProbeConfigurationError extends Schema.TaggedError<
  LiveAwsProbeConfigurationError
>()("LiveAwsProbeConfigurationError", {
  diagnosticCode: Schema.Literal("live-aws-probe-configuration-incomplete"),
  requiredVariables: Schema.Array(Schema.String)
}) {}

const configurationError = () =>
  new LiveAwsProbeConfigurationError({
    diagnosticCode: "live-aws-probe-configuration-incomplete",
    requiredVariables: [...REQUIRED_VARIABLES]
  })

const loadConfiguration = Effect.gen(function*() {
  const raw = yield* Config.all({
    activation: Config.string("CONTROL_CENTER_LIVE_AWS_PROBE"),
    awsRegion: Config.string("CONTROL_CENTER_TEST_AWS_REGION"),
    codeCommitRepository: Config.string("CONTROL_CENTER_TEST_CODECOMMIT_REPOSITORY"),
    codePipelinePipeline: Config.string("CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE"),
    roleArn: Config.string("CONTROL_CENTER_TEST_AWS_ROLE_ARN")
  }).pipe(Effect.mapError(configurationError))
  return yield* Schema.decodeUnknownEffect(LiveAwsProbeConfiguration)(raw).pipe(
    Effect.mapError(configurationError)
  )
})

const liveClients = Layer.merge(
  CodeCommit.CodeCommitReadClient.live.pipe(Layer.provide(AwsClientConfig.Default)),
  CodePipelineReadClient.live
).pipe(Layer.provide(NodeHttpClient.layerFetch))

describe("Control Center live AWS default credential chain", () => {
  it.effect("reads the stable CodeCommit and CodePipeline fixtures with the OIDC identity", () =>
    Effect.gen(function*() {
      const configuration = yield* loadConfiguration
      const roleMatch = /^arn:(?:aws|aws-us-gov):iam::([0-9]{12}):role\//u.exec(
        configuration.roleArn
      )
      assertLiveAwsProbe(roleMatch !== null, "configuration-role-arn-invalid")
      const expectedAccountId = roleMatch[1]
      assertLiveAwsProbe(
        expectedAccountId !== undefined,
        "configuration-role-arn-invalid"
      )
      const repositoryName = Schema.decodeUnknownSync(Domain.RepositoryName)(
        configuration.codeCommitRepository
      )

      const codeCommitAccount = {
        profile: Schema.decodeUnknownSync(Domain.AwsProfileName)("default"),
        region: Schema.decodeUnknownSync(Domain.AwsRegion)(configuration.awsRegion)
      }
      const codeCommit = yield* CodeCommit.CodeCommitReadClient
      const codeCommitIdentity = yield* sanitizeLiveAwsProbe(
        codeCommit.discoverAccount(codeCommitAccount),
        "codecommit-discover-account"
      )
      assertLiveAwsProbe(
        codeCommitIdentity.accountId === expectedAccountId,
        "codecommit-account-mismatch"
      )

      const repositoryExists = yield* sanitizeLiveAwsProbe(
        resourceExistsInBoundedPages({
          expectedName: repositoryName,
          maximumPages: 5,
          listPage: (nextToken) =>
            codeCommit
              .listRepositoriesPage({
                account: codeCommitAccount,
                nextToken
              })
              .pipe(
                Effect.map(({ nextToken: pageToken, repositoryNames }) => ({
                  names: repositoryNames,
                  nextToken: pageToken
                }))
              )
        }),
        "codecommit-list-repositories"
      )
      assertLiveAwsProbe(
        repositoryExists,
        "codecommit-repository-missing"
      )

      const stablePullRequest = yield* sanitizeLiveAwsProbe(
        findValueInBoundedPages({
          maximumPages: 5,
          listPage: (nextToken) =>
            codeCommit
              .listPullRequestsPage({
                account: codeCommitAccount,
                repositoryName,
                status: "OPEN",
                nextToken
              })
              .pipe(
                Effect.map(({ nextToken: pageToken, pullRequests }) => ({
                  values: pullRequests,
                  nextToken: pageToken
                }))
              ),
          matches: ({ destinationReference, sourceReference }) =>
            sourceReference === "refs/heads/fixture-change" &&
            destinationReference === "refs/heads/main"
        }),
        "codecommit-list-pull-requests"
      )
      assertLiveAwsProbe(
        stablePullRequest !== undefined,
        "codecommit-pull-request-missing"
      )

      const changedFiles = yield* sanitizeLiveAwsProbe(
        codeCommit.getChangedFilesPage({
          account: codeCommitAccount,
          repositoryName,
          beforeCommitSpecifier: stablePullRequest.destinationCommit,
          afterCommitSpecifier: stablePullRequest.sourceCommit,
          nextToken: null
        }),
        "codecommit-get-differences"
      )
      assertLiveAwsProbe(
        isExactLiveAwsFixtureDiff(changedFiles),
        "codecommit-diff-mismatch"
      )

      const pipelineAccount = {
        profile: "default",
        region: configuration.awsRegion,
        operationTimeoutMillis: 30_000
      }
      const codePipeline = yield* CodePipelineReadClient
      const codePipelineIdentity = yield* sanitizeLiveAwsProbe(
        codePipeline.discoverAccount(pipelineAccount),
        "codepipeline-discover-account"
      )
      assertLiveAwsProbe(
        codePipelineIdentity.accountId === expectedAccountId,
        "codepipeline-account-mismatch"
      )

      const pipelineExists = yield* sanitizeLiveAwsProbe(
        resourceExistsInBoundedPages({
          expectedName: configuration.codePipelinePipeline,
          maximumPages: 5,
          listPage: (nextToken) =>
            codePipeline
              .listPipelinesPage({
                account: pipelineAccount,
                nextToken
              })
              .pipe(
                Effect.map(({ nextToken: pageToken, pipelineNames }) => ({
                  names: pipelineNames,
                  nextToken: pageToken
                }))
              )
        }),
        "codepipeline-list-pipelines"
      )
      assertLiveAwsProbe(
        pipelineExists,
        "codepipeline-pipeline-missing"
      )
      const pipeline = yield* sanitizeLiveAwsProbe(
        codePipeline.getPipeline({
          account: pipelineAccount,
          pipelineName: configuration.codePipelinePipeline
        }),
        "codepipeline-get-pipeline"
      )
      assertLiveAwsProbe(
        pipeline.name === configuration.codePipelinePipeline &&
          matchesLiveAwsPipelineDefinition(pipeline, configuration.codeCommitRepository),
        "codepipeline-definition-mismatch"
      )

      let execution: CodePipelineExecutionSummary | undefined
      let nextToken: string | null = null
      for (let pageNumber = 0; pageNumber < 5 && execution === undefined; pageNumber += 1) {
        const page: CodePipelineExecutionPage = yield* sanitizeLiveAwsProbe(
          codePipeline.listExecutionsPage({
            account: pipelineAccount,
            pipelineName: configuration.codePipelinePipeline,
            nextToken
          }),
          "codepipeline-list-executions"
        )
        execution = page.executions.find(({ status }) => status === "Succeeded")
        nextToken = page.nextToken
        if (nextToken === null) break
      }
      assertLiveAwsProbe(
        execution !== undefined,
        "codepipeline-successful-execution-missing"
      )

      const snapshot = yield* sanitizeLiveAwsProbe(
        codePipeline.getExecutionSnapshot({
          account: pipelineAccount,
          pipelineName: configuration.codePipelinePipeline,
          pipelineExecutionId: execution.executionId,
          actionBounds: {
            pageSize: 50,
            maximumPages: 3,
            maximumActions: 100
          },
          summary: execution
        }),
        "codepipeline-get-execution-snapshot"
      )
      assertLiveAwsProbe(
        isSuccessfulExecutionForPipelineVersion(snapshot.execution, pipeline.version),
        "codepipeline-successful-execution-missing"
      )
      assertLiveAwsProbe(
        !snapshot.actionCollection.truncated,
        "codepipeline-action-history-truncated"
      )
      assertLiveAwsProbe(
        snapshot.actionCollection.actions.filter(
          ({ actionName, status }) => actionName === "ReadFixture" && status === "Succeeded"
        ).length === 1,
        "codepipeline-source-action-mismatch"
      )
      assertLiveAwsProbe(
        snapshot.actionCollection.actions.filter(
          ({ actionName, status }) => actionName === "ConfirmFixture" && status === "Succeeded"
        ).length === 1,
        "codepipeline-approval-action-mismatch"
      )

      const pipelineState = yield* sanitizeLiveAwsProbe(
        codePipeline.getPipelineState({
          account: pipelineAccount,
          pipelineName: configuration.codePipelinePipeline
        }),
        "codepipeline-get-state"
      )
      assertLiveAwsProbe(
        pipelineState.pipelineName === configuration.codePipelinePipeline,
        "codepipeline-state-mismatch"
      )
    }).pipe(Effect.provide(liveClients)))
})
