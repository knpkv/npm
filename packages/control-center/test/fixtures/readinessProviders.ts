import { ReadClient, ReviewClient } from "@knpkv/codecommit-core"
import { Effect, Layer, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"

import { CodePipelineReadClient } from "../../src/server/plugins/codepipeline/CodePipelineReadClient.js"
import {
  CodePipelineReadProvider,
  type CodePipelineReadProviderService
} from "../../src/server/plugins/codepipeline/CodePipelineReadProvider.js"

export const readinessProviderTime = "2026-10-11T10:00:00.000Z"
export const readinessReleaseVersion = "2.18.0"
export const readinessHeadCommit = "a".repeat(40)
export const readinessPipelineName = "fixture-pipeline"

export interface ReadinessProviderScenario {
  readonly build: "Succeeded" | "Failed" | "InProgress"
  readonly verify: "Succeeded" | "InProgress" | "not-started"
  readonly gate: "Succeeded" | "InProgress" | "not-started" | "absent"
  readonly deployment: "Succeeded" | "InProgress" | "not-started"
  readonly exactRunbookMetadata: boolean
  readonly secondEnvironmentDeployment?: "Succeeded" | "InProgress"
  readonly missingDeploymentAction?: boolean
  readonly missingRunbookBody?: boolean
  readonly truncateJiraAfterFirstSync?: boolean
  readonly boundedJiraCatchUp?: boolean
  readonly truncatedActions?: boolean
  readonly runbookTasks?: "checked" | "empty" | "unchecked"
  readonly releaseCount?: number
}

const actionDeclarations = [
  { stage: "Source", name: "Checkout", category: "Source", provider: "CodeCommit" },
  { stage: "Build", name: "Compile", category: "Build", provider: "CodeBuild" },
  { stage: "Verify", name: "Tests", category: "Test", provider: "CodeBuild" },
  { stage: "Approve", name: "Release", category: "Approval", provider: "Manual" },
  { stage: "Deploy", name: "Rollout", category: "Deploy", provider: "CodeDeploy" }
]

/** AWS transport values, decoded by the real CodePipeline client and plugin. */
export const readinessPipelineProvider = (scenario: ReadinessProviderScenario): CodePipelineReadProviderService => {
  const secondaryDeclarations = scenario.secondEnvironmentDeployment === undefined ? [] : [
    { stage: "ProductionApproval", name: "Production release", category: "Approval", provider: "Manual" },
    { stage: "ProductionDeploy", name: "Production rollout", category: "Deploy", provider: "CodeDeploy" }
  ]
  const primaryDeclarations = [
    ...actionDeclarations.filter(({ category }) => scenario.gate !== "absent" || category !== "Approval"),
    ...(scenario.missingDeploymentAction === true
      ? [{ stage: "Finalize", name: "Finalize rollout", category: "Deploy", provider: "CodeDeploy" }]
      : [])
  ]
  const declarations = [...primaryDeclarations, ...secondaryDeclarations]
  const status = scenario.build === "Failed"
    ? "Failed"
    : scenario.deployment === "Succeeded"
    ? "Succeeded"
    : "InProgress"
  const date = new Date(readinessProviderTime)
  const actionStatus = (category: string, stage: string) => {
    switch (category) {
      case "Build":
        return scenario.build
      case "Test":
        return scenario.verify
      case "Approval":
        return scenario.gate
      case "Deploy":
        return stage === "ProductionDeploy"
          ? scenario.secondEnvironmentDeployment ?? scenario.deployment
          : scenario.deployment
      default:
        return "Succeeded"
    }
  }
  const execution = {
    pipelineName: readinessPipelineName,
    pipelineVersion: 1,
    pipelineExecutionId: "execution-1",
    status,
    lastUpdateTime: date,
    artifactRevisions: [{ name: "Source", revisionId: readinessHeadCommit, created: date }]
  }
  const unused = () => Effect.die("Unexpected provider mutation or artifact/log request")
  return {
    getCallerIdentity: () => Effect.succeed({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:role/fixture" }),
    getPipeline: () =>
      Effect.succeed({
        pipeline: {
          name: readinessPipelineName,
          version: 1,
          pipelineType: "V1",
          executionMode: "SUPERSEDED",
          stages: declarations.map(({ category, name, provider, stage }) => {
            const action = { name, actionTypeId: { category, owner: "AWS", provider, version: "1" } }
            return {
              name: stage,
              actions: [
                category === "Source"
                  ? { ...action, configuration: { RepositoryName: "fixture-repository", BranchName: "main" } }
                  : action
              ]
            }
          })
        },
        metadata: {
          pipelineArn: `arn:aws:codepipeline:eu-west-1:123456789012:${readinessPipelineName}`,
          created: date,
          updated: date
        }
      }),
    listPipelinesPage: () => Effect.succeed({ pipelines: [] }),
    listPipelineExecutionsPage: () =>
      Effect.succeed({
        pipelineExecutionSummaries: [{
          pipelineExecutionId: "execution-1",
          status,
          startTime: date,
          lastUpdateTime: date,
          sourceRevisions: [{ actionName: "Checkout", revisionId: readinessHeadCommit }]
        }]
      }),
    getPipelineExecution: () => Effect.succeed({ pipelineExecution: execution }),
    listActionExecutionsPage: () => {
      const page = {
        actionExecutionDetails: declarations
          .filter(({ category, stage }) => actionStatus(category, stage) !== "not-started" && stage !== "Finalize")
          .map(({ category, name, provider, stage }) => ({
            pipelineExecutionId: "execution-1",
            actionExecutionId: `execution-1-${stage}`,
            pipelineVersion: 1,
            stageName: stage,
            actionName: name,
            status: actionStatus(category, stage),
            startTime: date,
            lastUpdateTime: date,
            input: { actionTypeId: { category, owner: "AWS", provider, version: "1" } }
          }))
      }
      return Effect.succeed(scenario.truncatedActions === true ? { ...page, nextToken: "remaining-actions" } : page)
    },
    getPipelineState: () =>
      Effect.succeed({
        pipelineName: readinessPipelineName,
        pipelineVersion: 1,
        stageStates: declarations.map(({ category, name, stage }) => {
          const action = { actionName: name }
          const latestExecution = {
            actionExecutionId: `execution-1-${stage}`,
            status: actionStatus(category, stage),
            lastStatusChange: date
          }
          const observed = {
            ...action,
            latestExecution: category === "Approval" && scenario.gate === "InProgress"
              ? { ...latestExecution, token: "fixture-approval-token" } :
              latestExecution
          }
          return {
            stageName: stage,
            actionStates: [actionStatus(category, stage) === "not-started" ? action : observed]
          }
        })
      }),
    getLogEventsPage: unused,
    getArtifactRange: unused,
    startPipelineExecution: unused,
    stopPipelineExecution: unused,
    putApprovalResult: unused
  }
}

export const readinessPipelineClientLayer = (scenario: ReadinessProviderScenario) =>
  CodePipelineReadClient.layer.pipe(
    Layer.provide(Layer.succeed(CodePipelineReadProvider, readinessPipelineProvider(scenario)))
  )

/** Only the AWS client seam is fake; CodeCommit synchronization and materialization are real. */
export const readinessCodeCommitClients = Layer.merge(
  Layer.mock(ReadClient.CodeCommitReadClient, {
    discoverAccount: () =>
      Effect.succeed(
        new ReadClient.CodeCommitAccountIdentity({
          accountId: "123456789012",
          arn: "arn:aws:iam::123456789012:role/fixture"
        })
      ),
    listPullRequestsPage: ({ status }) =>
      Effect.succeed(
        new ReadClient.CodeCommitPullRequestPage({
          pullRequests: status === "OPEN" ? [] : [
            Schema.decodeUnknownSync(ReadClient.CodeCommitPullRequestRevision)({
              pullRequestId: "17",
              revisionId: "pr-revision-1",
              repositoryName: "fixture-repository",
              title: "FIX-42 implement release work",
              description: "Exact Jira key in branch and title",
              authorArn: null,
              status: "MERGED",
              sourceReference: "refs/heads/feat/FIX-42-delivery",
              destinationReference: "refs/heads/main",
              sourceCommit: readinessHeadCommit,
              destinationCommit: "b".repeat(40),
              mergeBase: "b".repeat(40),
              creationDate: new Date(readinessProviderTime),
              lastActivityDate: new Date(readinessProviderTime)
            })
          ],
          nextToken: null
        })
      )
  }),
  Layer.mock(ReviewClient.CodeCommitReviewClient, {})
)

/** Fake provider wire responses; no normalized pages or domain assessments are seeded. */
export const readinessHttpTransport = (scenario: ReadinessProviderScenario, requestedPaths: Array<string>) => {
  // Keep each fixture issue and runbook below their independent metadata bounds.
  const releaseVersions = Array.from({ length: scenario.releaseCount ?? 1 }, (_, index) => ({
    id: String(20000 + index),
    name: `2.18.${index}`,
    released: false,
    archived: false
  }))
  const version = { number: 1, createdAt: readinessProviderTime }
  const taskContent = scenario.runbookTasks === "empty" ? [] : [{
    type: "taskList",
    attrs: { localId: "fixture-tasks" },
    content: [{
      type: "taskItem",
      attrs: { localId: "fixture-task", state: scenario.runbookTasks === "unchecked" ? "TODO" : "DONE" },
      content: [{ type: "text", text: "Rollout checklist complete" }]
    }]
  }]
  const pageMetadata = {
    id: "42",
    status: "current",
    title: `Release ${readinessReleaseVersion} runbook`,
    spaceId: "space-1",
    createdAt: readinessProviderTime,
    version,
    labels: {
      results: scenario.exactRunbookMetadata
        ? releaseVersions.map(({ name }, index) => ({ id: `label-${index + 1}`, prefix: "global", name }))
        : [],
      meta: { hasMore: false }
    },
    _links: { webui: "/spaces/FIX/pages/42" }
  }
  const page = scenario.missingRunbookBody === true ? pageMetadata : {
    ...pageMetadata,
    body: {
      atlas_doc_format: {
        representation: "atlas_doc_format",
        value: JSON.stringify({
          type: "doc",
          version: 1,
          content: scenario.runbookTasks === "empty"
            ? []
            : [{ type: "paragraph", content: [{ type: "text", text: "Release runbook" }] }, ...taskContent]
        })
      }
    }
  }
  const issue = {
    id: "10042",
    key: "FIX-42",
    fields: {
      summary: "Implement release work",
      project: { id: "10000", key: "FIX", name: "Fixture service" },
      status: { name: "Done" },
      issuetype: { name: "Story" },
      created: readinessProviderTime,
      updated: readinessProviderTime,
      fixVersions: releaseVersions
    }
  }
  let jiraSearchCount = 0
  return HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname
      requestedPaths.push(path)
      if (path === "/rest/api/3/search/jql") jiraSearchCount += 1
      const jiraIssue = scenario.truncateJiraAfterFirstSync === true && jiraSearchCount > 1 ?
        {
          ...issue,
          fields: {
            ...issue.fields,
            updated: "2026-10-11T10:00:01.000Z",
            fixVersions: issue.fields.fixVersions.map((version) => ({ ...version, releaseDate: "x".repeat(101) }))
          }
        } :
        issue
      const body = path === "/rest/api/3/myself"
        ? { accountId: "release-owner", displayName: "Release Owner", active: true, timeZone: "UTC" }
        : path === "/rest/api/3/search/jql" ?
        scenario.boundedJiraCatchUp === true
          ? jiraSearchCount <= 3
            ? {
              issues: [
                jiraSearchCount === 1 ? jiraIssue : {
                  ...jiraIssue,
                  id: String(10041 + jiraSearchCount),
                  key: `FIX-${41 + jiraSearchCount}`,
                  fields: { ...jiraIssue.fields, fixVersions: [] }
                }
              ],
              isLast: false,
              nextPageToken: `fixture-page-${jiraSearchCount}`
            }
            : { issues: [], isLast: true }
          : { issues: [jiraIssue], isLast: true }
        : path.startsWith("/rest/api/3/issue/") && path.endsWith("/comment") ?
        { startAt: 0, maxResults: 10, total: 0, comments: [] }
        : path.startsWith("/rest/api/3/issue/") && path.endsWith("/changelog") ?
        { startAt: 0, maxResults: 10, total: 0, isLast: true, values: [] }
        : path === "/wiki/api/v2/spaces/space-1/pages" ?
        { results: [page] }
        : path === "/wiki/api/v2/pages/42" ?
        page
        : path === "/wiki/api/v2/pages/42/versions" ?
        { results: [version] }
        : path === "/wiki/api/v2/pages/42/attachments" ?
        { results: [] }
        : path === "/wiki/api/v2/pages/42/labels" ?
        page.labels
        : path === "/wiki/rest/api/content/42/notification/child-created" ?
        { results: [], start: 0, limit: 50, size: 0 }
        : path === "/wiki/api/v2/users-bulk" ?
        { results: [] }
        : null
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body ?? { message: `Unscripted fixture endpoint: ${path}` }), {
          status: body === null ? 404 : 200,
          headers: { "content-type": "application/json" }
        })
      )
    })
  )
}
