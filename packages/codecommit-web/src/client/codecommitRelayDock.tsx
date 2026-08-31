import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import {
  PullRequestConversation,
  PullRequestConversationAmbiguous,
  PullRequestConversationContinuationFailed,
  PullRequestConversationContinuationRejected,
  PullRequestConversationNotFound,
  PullRequestConversationRedirectFailed,
  pullRequestThreadIdentity,
  RelayAuthenticationRequired,
  RelayProductDock,
  type RelayProductDockHost,
  type RelayProductDockMessage,
  RelaySelectorState,
  type RelayPullRequestDockRegistration,
  useRelayPullRequestDock
} from "@knpkv/relay-product"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type ReactElement, type ReactNode, useMemo } from "react"
import { useNavigate } from "react-router"

import type {
  PullRequestDiffResponse,
  PullRequestRelayReviewResponse,
  RelayReviewConversationTurn
} from "../server/Api.js"
import { useAtomValue } from "@effect/atom-react"
import { appStateAtom } from "./atoms/app.js"

const hostSelection = Schema.decodeUnknownSync(RelaySelectorState)({
  modelId: "configured-default",
  models: [{ id: "configured-default", label: "Configured default" }],
  profileId: "configured-review",
  profiles: [{ id: "configured-review", label: "Configured review" }]
})

const accountIdentity = (pullRequest: Domain.PullRequest): string =>
  pullRequest.account.awsAccountId ?? pullRequest.account.profile

/** Install CodeCommit's authenticated PR locator behind the shared Relay dock. */
export const CodeCommitRelayDock = ({ children }: { readonly children: ReactNode }): ReactElement => {
  const state = useAtomValue(appStateAtom)
  const navigate = useNavigate()
  const host = useMemo<RelayProductDockHost>(
    () => ({
      context: [{ id: "product", label: "Product", value: "CodeCommit" }],
      locatePullRequestConversation: Effect.fn("CodeCommitRelayDock.locatePullRequestConversation")(
        function* (locator) {
          if (state.currentUser === undefined) {
            return yield* new RelayAuthenticationRequired({
              operation: "locate-pull-request-conversation",
              product: "codecommit"
            })
          }
          const matches = state.pullRequests.filter(
            (pullRequest) =>
              String(pullRequest.id) === String(locator.pullRequestId) &&
              String(pullRequest.repositoryName) === String(locator.repositoryName) &&
              String(pullRequest.account.region) === String(locator.region) &&
              (locator.accountId === undefined || accountIdentity(pullRequest) === locator.accountId)
          )
          if (matches.length === 0) {
            return yield* new PullRequestConversationNotFound({
              product: "codecommit",
              pullRequestId: locator.pullRequestId,
              repositoryName: locator.repositoryName
            })
          }
          if (matches.length > 1) {
            return yield* new PullRequestConversationAmbiguous({
              matches: matches.length,
              product: "codecommit",
              pullRequestId: locator.pullRequestId,
              repositoryName: locator.repositoryName
            })
          }
          const match = matches[0]
          if (match === undefined) {
            return yield* new PullRequestConversationNotFound({
              product: "codecommit",
              pullRequestId: locator.pullRequestId,
              repositoryName: locator.repositoryName
            })
          }
          const accountId = accountIdentity(match)
          const href = `/accounts/${encodeURIComponent(accountId)}/prs/${encodeURIComponent(match.id)}`
          yield* Effect.tryPromise({
            try: async () => {
              await navigate(href)
            },
            catch: () => new PullRequestConversationRedirectFailed({ href, product: "codecommit" })
          })
        }
      ),
      product: "codecommit",
      selection: hostSelection
    }),
    [navigate, state.currentUser, state.pullRequests]
  )
  return <RelayProductDock host={host}>{children}</RelayProductDock>
}

interface ReviewProfileSelection {
  readonly id: string
  readonly name: string
}

interface CodeCommitRelayThreadProps {
  readonly accountId: string
  readonly continueReview: (findingId: string, message: string) => Promise<void>
  readonly diff: PullRequestDiffResponse
  readonly isReviewing: boolean
  readonly profile: ReviewProfileSelection | undefined
  readonly pullRequest: Domain.PullRequest
  readonly review: PullRequestRelayReviewResponse | null
  readonly selectedFindingId: string | null
  readonly turns: ReadonlyArray<RelayReviewConversationTurn>
}

const relayMessageRole = (role: RelayReviewConversationTurn["role"]): RelayProductDockMessage["role"] =>
  role === "user" ? "operator" : "relay"

const threadMessages = (
  review: PullRequestRelayReviewResponse,
  turns: ReadonlyArray<RelayReviewConversationTurn>
): ReadonlyArray<RelayProductDockMessage> => [
  { id: `review:${review.revisionId}`, role: "relay", text: review.result.verdict },
  ...turns.map((turn, index) => ({
    id: `${turn.findingId}:${turn.role}:${String(index)}`,
    role: relayMessageRole(turn.role),
    text: turn.message
  }))
]

/** Register CodeCommit's persisted per-PR review conversation with the shared shell dock. */
export const CodeCommitRelayThread = ({
  accountId,
  continueReview,
  diff,
  isReviewing,
  profile,
  pullRequest,
  review,
  selectedFindingId,
  turns
}: CodeCommitRelayThreadProps): null => {
  const selection = useMemo(
    () =>
      Schema.decodeUnknownSync(RelaySelectorState)({
        modelId: "configured-default",
        models: [{ id: "configured-default", label: "Configured default" }],
        profileId: profile?.id ?? "configured-review",
        profiles: [{ id: profile?.id ?? "configured-review", label: profile?.name ?? "Configured review" }]
      }),
    [profile?.id, profile?.name]
  )
  const conversation = useMemo(
    () =>
      Schema.decodeUnknownSync(PullRequestConversation)({
        _tag: "codecommit",
        route: {
          accountId,
          href: `/accounts/${encodeURIComponent(accountId)}/prs/${encodeURIComponent(pullRequest.id)}`,
          pullRequestId: pullRequest.id
        },
        selection,
        thread: {
          accountId,
          pullRequestId: pullRequest.id,
          repositoryName: pullRequest.repositoryName
        }
      }),
    [accountId, pullRequest.id, pullRequest.repositoryName, selection]
  )
  const registration = useMemo<RelayPullRequestDockRegistration>(() => {
    const base = {
      context: [
        { id: "repository", label: "Repository", value: pullRequest.repositoryName },
        { id: "pull-request", label: "Pull request", value: `#${pullRequest.id}` },
        { id: "head", label: "Current head", value: diff.headCommit.slice(0, 12) }
      ],
      conversation,
      selection
    }
    if (profile === undefined) {
      return {
        ...base,
        description: "Configure a CodeCommit Relay review profile before starting this PR thread.",
        status: "unavailable"
      }
    }
    if (review === null || selectedFindingId === null) {
      return {
        ...base,
        description: "Run Relay in the exact-revision review workspace to start this PR thread.",
        status: "unavailable"
      }
    }
    return {
      ...base,
      continuePullRequestConversation: (request) => {
        const thread = pullRequestThreadIdentity(conversation)
        if (isReviewing) {
          return new PullRequestConversationContinuationRejected({
            product: "codecommit",
            reason: "conversation-busy",
            thread
          })
        }
        if (request.selection.profileId !== selection.profileId || request.selection.modelId !== selection.modelId) {
          return new PullRequestConversationContinuationRejected({
            product: "codecommit",
            reason: "selection-unavailable",
            thread
          })
        }
        return Effect.tryPromise({
          try: () => continueReview(selectedFindingId, request.message),
          catch: () => new PullRequestConversationContinuationFailed({ product: "codecommit", thread })
        })
      },
      messages: threadMessages(review, turns),
      status: "ready"
    }
  }, [
    conversation,
    continueReview,
    diff.headCommit,
    isReviewing,
    profile,
    pullRequest.id,
    pullRequest.repositoryName,
    review,
    selectedFindingId,
    selection,
    turns
  ])
  useRelayPullRequestDock(registration)
  return null
}
