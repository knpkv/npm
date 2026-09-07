import * as Ref from "effect/Ref"
import type * as Schema from "effect/Schema"

import type { CodeCommitMockScenario, MockPullRequest, MockPullRequestRevision } from "./Scenario.js"

export interface MockComment {
  readonly commentId: string
  readonly pullRequestId: string
  readonly repositoryName: string
  readonly beforeCommitId: string
  readonly afterCommitId: string
  readonly content: string
  readonly authorArn: string
  readonly creationEpochSeconds: number
  readonly clientRequestToken: string | null
  readonly inReplyTo: string | null
  readonly location: {
    readonly filePath?: string
    readonly filePosition?: number
    readonly relativeFileVersion?: string
  } | null
}

export interface MockApproval {
  readonly pullRequestId: string
  readonly revisionId: string
  readonly state: "APPROVE" | "REVOKE"
}

export interface MockRequestReceipt {
  readonly sequence: number
  readonly operation: string
  readonly input: Schema.Json
}

export interface CodeCommitMockState {
  readonly scenario: CodeCommitMockScenario
  readonly activeRevisionByPullRequest: Readonly<Record<string, number>>
  readonly comments: ReadonlyArray<MockComment>
  readonly approvals: ReadonlyArray<MockApproval>
  readonly requests: ReadonlyArray<MockRequestReceipt>
}

const initialRevisionEntry = (pullRequest: MockPullRequest): readonly [string, number] => [
  pullRequest.pullRequestId,
  0
]

export const makeInitialState = (scenario: CodeCommitMockScenario): CodeCommitMockState => ({
  scenario,
  activeRevisionByPullRequest: Object.fromEntries(
    scenario.repositories.flatMap((repository) => repository.pullRequests.map(initialRevisionEntry))
  ),
  comments: [],
  approvals: [],
  requests: []
})

export const findPullRequest = (
  state: CodeCommitMockState,
  pullRequestId: string
): { readonly pullRequest: MockPullRequest; readonly repositoryName: string } | null => {
  for (const repository of state.scenario.repositories) {
    const pullRequest = repository.pullRequests.find((candidate) => candidate.pullRequestId === pullRequestId)
    if (pullRequest !== undefined) return { pullRequest, repositoryName: repository.repositoryName }
  }
  return null
}

export const activeRevision = (
  state: CodeCommitMockState,
  pullRequest: MockPullRequest
): MockPullRequestRevision => {
  const index = state.activeRevisionByPullRequest[pullRequest.pullRequestId] ?? 0
  return pullRequest.revisions[index] ?? pullRequest.revisions[0]
}

export const recordRequest = (
  ref: Ref.Ref<CodeCommitMockState>,
  operation: string,
  input: Schema.Json
) =>
  Ref.update(ref, (state) => ({
    ...state,
    requests: [...state.requests, { sequence: state.requests.length + 1, operation, input }]
  }))
