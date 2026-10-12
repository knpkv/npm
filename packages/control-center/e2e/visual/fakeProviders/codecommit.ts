import * as Schema from "effect/Schema"

import { readinessPortfolio } from "./readinessPortfolio.js"
import type { ProviderScenario } from "./transport.js"

const AwsInput = Schema.Struct({
  repositoryName: Schema.optionalKey(Schema.String),
  pullRequestId: Schema.optionalKey(Schema.String),
  pullRequestStatus: Schema.optionalKey(Schema.String),
  nextToken: Schema.optionalKey(Schema.String)
})

/** AWS JSON 1.1 protocol data is decoded by distilled, then the production read/review clients. */
export const codeCommitResponse = (
  operation: string,
  rawInput: string,
  label: string,
  scenario: ProviderScenario,
  sixVerdicts = false
) => {
  const input = Schema.decodeUnknownSync(AwsInput)(JSON.parse(rawInput))
  const accountId = label === "codecommit-a" ? "111111111111" : "222222222222"
  const repositoryName = input.repositoryName ?? (label === "codecommit-a" ? "fixture-checkout" : "fixture-catalogue")
  const release = readinessPortfolio.find(({ pullRequestId }) => pullRequestId === input.pullRequestId)
  const revision = sixVerdicts ? release?.headRevision : "a".repeat(40)
  switch (operation) {
    case "ListRepositories":
      return { repositories: [{ repositoryName, repositoryId: `fixture-repository-${label}` }] }
    case "GetRepository":
      return {
        repositoryMetadata: {
          accountId,
          repositoryName,
          repositoryId: `fixture-repository-${label}`,
          defaultBranch: "main",
          Arn: `arn:aws:codecommit:us-east-1:${accountId}:${repositoryName}`
        }
      }
    case "ListPullRequests":
      if (sixVerdicts) {
        return {
          pullRequestIds: input.pullRequestStatus === "CLOSED"
            ? readinessPortfolio.map(({ pullRequestId }) => pullRequestId)
            : []
        }
      }
      return {
        pullRequestIds: input.pullRequestStatus === "CLOSED" || input.nextToken !== undefined ? [] : ["1"],
        nextToken: scenario === "paginated" && input.nextToken === undefined ? "fixture-next-page" : undefined
      }
    case "GetPullRequest":
      return {
        pullRequest: {
          pullRequestId: sixVerdicts ? release?.pullRequestId : "1",
          title: sixVerdicts
            ? `${release?.issueKey} fixture delivery`
            : label === "codecommit-a"
            ? "FIX-1 fixture checkout"
            : "CAT-1 fixture catalogue",
          description: sixVerdicts
            ? `Fixture release ${release?.version}`
            : label === "codecommit-a"
            ? "Fixture release 1.0.0"
            : "Fixture release 2.0.0",
          revisionId: "1",
          creationDate: 1784026500,
          lastActivityDate: 1784030100,
          pullRequestStatus: sixVerdicts ? "CLOSED" : "OPEN",
          authorArn: `arn:aws:iam::${accountId}:user/fixture-owner`,
          approvalRules: [],
          pullRequestTargets: [{
            repositoryName,
            sourceReference: sixVerdicts ? `refs/heads/fixture-${release?.issueKey}` : "refs/heads/fixture-change",
            destinationReference: "refs/heads/main",
            sourceCommit: revision,
            destinationCommit: "b".repeat(40),
            mergeBase: "b".repeat(40),
            mergeMetadata: { isMerged: sixVerdicts }
          }]
        }
      }
    case "GetPullRequestApprovalStates":
      return { approvals: [{ userArn: `arn:aws:iam::${accountId}:user/fixture-approver`, approvalState: "APPROVE" }] }
    case "EvaluatePullRequestApprovalRules":
      return {
        evaluation: { approved: true, overridden: false, approvalRulesSatisfied: [], approvalRulesNotSatisfied: [] }
      }
    case "GetPullRequestOverrideState":
      return { overridden: false }
    case "GetDifferences":
      return { differences: [] }
    case "UpdatePullRequestApprovalState":
      return {}
    case "MergePullRequestByFastForward":
      return { pullRequest: { pullRequestId: "1", pullRequestStatus: "CLOSED" } }
    default:
      return undefined
  }
}

export const callerIdentityXml = (label: string): string => {
  const accountId = label.endsWith("-a") ? "111111111111" : "222222222222"
  return `<?xml version="1.0"?><GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::${accountId}:user/fixture-owner</Arn><UserId>fixture-owner</UserId><Account>${accountId}</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>fixture-request</RequestId></ResponseMetadata></GetCallerIdentityResponse>`
}
