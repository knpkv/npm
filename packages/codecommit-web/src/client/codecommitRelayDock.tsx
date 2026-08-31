import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import {
  PullRequestConversation,
  PullRequestConversationAmbiguous,
  PullRequestConversationContinuationFailed,
  PullRequestConversationContinuationRejected,
  type PullRequestConversationLocator,
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
import {
  codeCommitPullRequestHref,
  matchesCodeCommitPullRequestRoute,
  type CodeCommitPullRequestRouteCoordinates
} from "./codecommit-route.js"

const hostSelection = Schema.decodeUnknownSync(RelaySelectorState)({
  modelId: "configured-default",
  models: [{ id: "configured-default", label: "Configured default" }],
  profileId: "configured-review",
  profiles: [{ id: "configured-review", label: "Configured review" }]
})

export const codeCommitRepositoryAccountIdentity = (account: Domain.Account): string =>
  account.repoAccountId ?? account.awsAccountId ?? account.profile

export const codeCommitRouteAccountIdentity = (account: Domain.Account): string =>
  account.awsAccountId ?? account.profile

/** Install CodeCommit's authenticated PR locator behind the shared Relay dock. */
export const CodeCommitRelayDock = ({ children }: { readonly children: ReactNode }): ReactElement => {
  const state = useAtomValue(appStateAtom)
  const navigate = useNavigate()
  const host = useMemo<RelayProductDockHost>(
    () => ({
      context: [{ id: "product", label: "Product", value: "CodeCommit" }],
      locatePullRequestConversation: Effect.fn("CodeCommitRelayDock.locatePullRequestConversation")(function* (
        locator: PullRequestConversationLocator
      ) {
        if (state.currentUser === undefined) {
          return yield* new RelayAuthenticationRequired({
            operation: "locate-pull-request-conversation",
            product: "codecommit"
          })
        }
        let route: CodeCommitPullRequestRouteCoordinates = {
          pullRequestId: String(locator.pullRequestId),
          region: String(locator.region),
          repositoryName: String(locator.repositoryName)
        }
        if (locator.accountId !== undefined) route = { ...route, accountId: locator.accountId }
        const matches = state.pullRequests.filter((pullRequest) =>
          matchesCodeCommitPullRequestRoute(pullRequest, route)
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
        const routeAccountId = codeCommitRouteAccountIdentity(match.account)
        const href = codeCommitPullRequestHref(
          routeAccountId,
          String(match.id),
          String(match.repositoryName),
          String(match.account.region)
        )
        yield* Effect.tryPromise({
          try: async () => {
            await navigate(href)
          },
          catch: (): PullRequestConversationRedirectFailed =>
            new PullRequestConversationRedirectFailed({ href, product: "codecommit" })
        })
      }),
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
  readonly continueReview: (findingId: string, message: string) => Promise<CodeCommitRelayContinuationOutcome>
  readonly diff: PullRequestDiffResponse
  readonly isReviewing: boolean
  readonly profile: ReviewProfileSelection | undefined
  readonly pullRequest: Domain.PullRequest
  readonly review: PullRequestRelayReviewResponse | null
  readonly selectedFindingId: string | null
  readonly turns: ReadonlyArray<RelayReviewConversationTurn>
}

export type CodeCommitRelayContinuationOutcome = { readonly _tag: "completed" } | { readonly _tag: "failed" }

const relayMessageRole = (role: RelayReviewConversationTurn["role"]): RelayProductDockMessage["role"] =>
  role === "user" ? "operator" : "relay"

const reviewExplanationMessages = (review: PullRequestRelayReviewResponse): ReadonlyArray<RelayProductDockMessage> =>
  review.result.explanation === undefined
    ? []
    : [{ id: `explanation:${review.revisionId}`, role: "relay", text: review.result.explanation }]

const threadMessages = (
  review: PullRequestRelayReviewResponse,
  turns: ReadonlyArray<RelayReviewConversationTurn>
): ReadonlyArray<RelayProductDockMessage> => [
  { id: `review:${review.revisionId}`, role: "relay", text: review.result.verdict },
  ...reviewExplanationMessages(review),
  ...turns.map((turn, index) => ({
    id: `${turn.findingId}:${turn.role}:${String(index)}`,
    role: relayMessageRole(turn.role),
    text: turn.message
  }))
]

interface CodeCommitRelayThreadRegistrationInput {
  readonly available: boolean
  readonly context: RelayPullRequestDockRegistration["context"]
  readonly continueReview: (findingId: string, message: string) => Promise<CodeCommitRelayContinuationOutcome>
  readonly conversation: PullRequestConversation
  readonly isReviewing: boolean
  readonly review: PullRequestRelayReviewResponse | null
  readonly selectedFindingId: string | null
  readonly selection: RelaySelectorState
  readonly turns: ReadonlyArray<RelayReviewConversationTurn>
}

/** Build the CodeCommit registration without hiding transport or selection failures behind React state. */
export const makeCodeCommitRelayThreadRegistration = ({
  available,
  context,
  continueReview,
  conversation,
  isReviewing,
  review,
  selectedFindingId,
  selection,
  turns
}: CodeCommitRelayThreadRegistrationInput): RelayPullRequestDockRegistration => {
  const base = { context, conversation, selection }
  if (!available) {
    return {
      ...base,
      description: "Configure a CodeCommit Relay review profile before starting this PR thread.",
      status: "unavailable"
    }
  }
  if (review === null) {
    return {
      ...base,
      description: "Run Relay in the exact-revision review workspace to start this PR thread.",
      status: "unavailable"
    }
  }
  const thread = pullRequestThreadIdentity(conversation)
  const continuationTarget = selectedFindingId ?? "PR"
  return {
    ...base,
    continuePullRequestConversation: (request) => {
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
        try: () => continueReview(continuationTarget, request.message),
        catch: (): PullRequestConversationContinuationFailed =>
          new PullRequestConversationContinuationFailed({ product: "codecommit", thread })
      }).pipe(
        Effect.flatMap((outcome) =>
          outcome._tag === "completed"
            ? Effect.void
            : new PullRequestConversationContinuationFailed({ product: "codecommit", thread })
        )
      )
    },
    messages: threadMessages(review, turns),
    status: "ready"
  }
}

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
  const repositoryAccountId = codeCommitRepositoryAccountIdentity(pullRequest.account)
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
          accountId: repositoryAccountId,
          pullRequestId: pullRequest.id,
          region: pullRequest.account.region,
          repositoryName: pullRequest.repositoryName
        }
      }),
    [accountId, pullRequest.id, pullRequest.repositoryName, repositoryAccountId, selection]
  )
  const registration = useMemo<RelayPullRequestDockRegistration>(() => {
    return makeCodeCommitRelayThreadRegistration({
      available: profile !== undefined,
      context: [
        { id: "repository", label: "Repository", value: pullRequest.repositoryName },
        { id: "pull-request", label: "Pull request", value: `#${pullRequest.id}` },
        { id: "head", label: "Current head", value: diff.headCommit.slice(0, 12) }
      ],
      continueReview,
      conversation,
      isReviewing,
      review,
      selectedFindingId,
      selection,
      turns
    })
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
