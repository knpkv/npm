import * as Effect from "effect/Effect"

import {
  type CodePipelineAwsAccount,
  type CodePipelineReadProviderService,
  mapCodePipelineAwsFailure
} from "../../../src/server/plugins/codepipeline/CodePipelineReadProvider.js"
import { PluginTimeoutFailure } from "../../../src/server/plugins/failures.js"
import { awsErrorResponse } from "./awsErrors.js"
import { readinessPortfolio, type ReadinessPortfolioRelease } from "./readinessPortfolio.js"
import { type FakeProviders, UnhandledProviderRequest } from "./transport.js"

const observedAt = new Date("2026-07-14T11:55:00.000Z")
const executionId = "01890f6f-6d6a-7cc0-98d2-000000000101"
const actionTypes = [
  { name: "Source", category: "Source", provider: "CodeCommit" },
  { name: "Build", category: "Build", provider: "CodeBuild" },
  { name: "Approve", category: "Approval", provider: "Manual" },
  { name: "Deploy", category: "Deploy", provider: "CodeDeploy" }
]

/** Raw AWS provider seam also covers SDK-only GetPipelineState; the production Schema client and plugin remain real. */
export const makeCodePipelineProvider = (providers: FakeProviders) => {
  const approvals = new Map<string, "waiting" | "not-waiting" | "failed">()
  const declarations = () =>
    providers.hasReadinessPortfolio()
      ? [
        ...actionTypes.slice(0, 2),
        { name: "Verify", category: "Test", provider: "CodeBuild" },
        ...actionTypes.slice(2)
      ]
      : actionTypes
  const execution = (id: string) =>
    providers.hasReadinessPortfolio()
      ? readinessPortfolio.find(({ executionId }) => executionId === id)
      : undefined
  const executionStatus = (release: ReadinessPortfolioRelease) =>
    ({
      blocked: "Failed",
      ready: "InProgress",
      deploying: "InProgress",
      building: "InProgress",
      shipped: "Succeeded",
      held: "InProgress"
    })[release.verdict]
  const actionStatus = (release: ReadinessPortfolioRelease, category: string) => {
    switch (category) {
      case "Source":
        return "Succeeded"
      case "Build":
        return release.build
      case "Test":
        return release.verify
      case "Approval":
        return release.gate
      case "Deploy":
        return release.deploy
      default:
        return undefined
    }
  }
  const call = <Value>(operation: string, account: CodePipelineAwsAccount, value: Value) =>
    Effect.gen(function*() {
      const label = account.profile.endsWith("-b") ? "codepipeline-b" : "codepipeline-a"
      const accessKeyId = account.profile.endsWith("-b") ? "FIXTUREB" : "FIXTUREA"
      const scenario = providers.recordPipelineRequest(label, accessKeyId, operation)
      if (scenario === "timeout") {
        return yield* Effect.never.pipe(Effect.timeoutOrElse({
          duration: account.operationTimeoutMillis,
          orElse: () => Effect.fail(new PluginTimeoutFailure({ operation }))
        }))
      }
      if (scenario === "malformed" || scenario === "truncated") return { fixtureInvalid: true }
      const failure = awsErrorResponse(scenario)
      if (failure !== undefined) {
        return yield* mapCodePipelineAwsFailure(operation, {
          name: failure.json.__type,
          $metadata: { httpStatusCode: failure.status },
          $response: { headers: failure.headers, body: failure.body }
        })
      }
      return value
    })
  const accountId = (account: CodePipelineAwsAccount) =>
    account.profile.endsWith("-b") ? "222222222222" : "111111111111"
  const approval = (account: CodePipelineAwsAccount) => approvals.get(account.profile) ?? "waiting"
  const service = {
    getCallerIdentity: (account) =>
      call("GetCallerIdentity", account, {
        Account: accountId(account),
        Arn: `arn:aws:iam::${accountId(account)}:user/fixture-owner`
      }),
    getPipeline: (request) =>
      call("GetPipeline", request.account, {
        pipeline: {
          name: request.pipelineName,
          version: 1,
          pipelineType: providers.hasReadinessPortfolio() ? "V2" : "V1",
          executionMode: providers.hasReadinessPortfolio() ? "PARALLEL" : "SUPERSEDED",
          stages: declarations().map((action) => ({
            name: action.name,
            actions: [{
              name: action.name,
              actionTypeId: { category: action.category, owner: "AWS", provider: action.provider, version: "1" },
              runOrder: 1,
              configuration: action.category === "Source"
                ? { RepositoryName: "fixture-checkout", BranchName: "main", PollForSourceChanges: "false" }
                : {}
            }]
          }))
        },
        metadata: {
          pipelineArn: `arn:aws:codepipeline:${request.account.region}:${
            accountId(request.account)
          }:${request.pipelineName}`,
          created: observedAt,
          updated: observedAt
        }
      }),
    listPipelinesPage: (request) =>
      call("ListPipelines", request.account, {
        pipelines: [{ name: "fixture-pipeline", version: 1, created: observedAt, updated: observedAt }]
      }),
    listPipelineExecutionsPage: (request) => {
      const page = [
        null,
        ...readinessPortfolio.slice(1).map((_, index) => `fixture-execution-page-${String(index + 1)}`)
      ].indexOf(request.nextToken)
      if (providers.hasReadinessPortfolio() && page < 0) {
        return Effect.die(
          new UnhandledProviderRequest({ method: "POST", path: "/ListPipelineExecutions", operation: "unknown-cursor" })
        )
      }
      return call("ListPipelineExecutions", request.account, {
        ...(providers.hasReadinessPortfolio() && page + 1 < readinessPortfolio.length &&
          { nextToken: `fixture-execution-page-${String(page + 1)}` }),
        pipelineExecutionSummaries: providers.hasReadinessPortfolio()
          ? readinessPortfolio.slice(page, page + request.maximumResults).map((release) => ({
            pipelineExecutionId: release.executionId,
            status: executionStatus(release),
            startTime: observedAt,
            lastUpdateTime: observedAt,
            sourceRevisions: [{ actionName: "Source", revisionId: release.headRevision }]
          }))
          : request.nextToken === null
          ? [{
            pipelineExecutionId: executionId,
            status: "InProgress",
            startTime: observedAt,
            lastUpdateTime: observedAt,
            sourceRevisions: [{
              actionName: "Source",
              revisionId: "a".repeat(40),
              revisionSummary: "FIX-1 fixture release 1.0.0"
            }]
          }]
          : []
      })
    },
    getPipelineExecution: (request) => {
      const release = execution(request.pipelineExecutionId)
      return call("GetPipelineExecution", request.account, {
        pipelineExecution: {
          pipelineName: request.pipelineName,
          pipelineVersion: 1,
          pipelineExecutionId: request.pipelineExecutionId,
          status: release === undefined ? "InProgress" : executionStatus(release),
          lastUpdateTime: observedAt,
          artifactRevisions: [{
            name: "Source",
            revisionId: execution(request.pipelineExecutionId)?.headRevision ?? "a".repeat(40),
            revisionSummary: "FIX-1 fixture release 1.0.0"
          }]
        }
      })
    },
    listActionExecutionsPage: (request) => {
      const release = execution(request.pipelineExecutionId)
      return call("ListActionExecutions", request.account, {
        actionExecutionDetails: declarations().filter((action) =>
          release === undefined || actionStatus(release, action.category) !== "not-started"
        ).map((action) => ({
          pipelineExecutionId: request.pipelineExecutionId,
          actionExecutionId: `fixture-${request.pipelineExecutionId}-${action.name}`,
          stageName: action.name,
          actionName: action.name,
          startTime: observedAt,
          lastUpdateTime: observedAt,
          status: release === undefined ?
            action.category === "Approval"
              ? approval(request.account) === "failed"
                ? "Failed"
                : approval(request.account) === "waiting"
                ? "InProgress"
                : "Succeeded"
              : "Succeeded" :
            actionStatus(release, action.category),
          input: { actionTypeId: { category: action.category, owner: "AWS", provider: action.provider, version: "1" } }
        }))
      })
    },
    getPipelineState: (request) =>
      call("GetPipelineState", request.account, {
        pipelineName: request.pipelineName,
        pipelineVersion: 1,
        stageStates: declarations().map((action) => ({
          stageName: action.name,
          actionStates: [{
            actionName: action.name,
            latestExecution: {
              actionExecutionId: `fixture-${action.name}`,
              status: action.category === "Approval" && approval(request.account) === "waiting"
                ? "InProgress"
                : approval(request.account) === "failed"
                ? "Failed"
                : "Succeeded",
              ...(action.category === "Approval" && approval(request.account) === "waiting" && {
                token: "fixture-approval-token"
              }),
              lastStatusChange: observedAt
            }
          }]
        }))
      }),
    getLogEventsPage: (request) =>
      call("GetLogEvents", request.account, { events: [], nextForwardToken: "fixture-complete" }),
    getArtifactRange: (request) =>
      call("GetArtifactRange", request.account, {
        bytes: new Uint8Array(),
        contentLength: 0,
        contentRange: "bytes */0"
      }),
    startPipelineExecution: (request) =>
      call("StartPipelineExecution", request.account, { pipelineExecutionId: executionId }),
    stopPipelineExecution: (request) =>
      call("StopPipelineExecution", request.account, { pipelineExecutionId: executionId }),
    putApprovalResult: (request) => call("PutApprovalResult", request.account, { approvedAt: observedAt })
  } satisfies CodePipelineReadProviderService
  return {
    service,
    setApproval: (profile: string, state: "waiting" | "not-waiting" | "failed") => {
      approvals.set(profile, state)
    }
  }
}
