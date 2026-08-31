import { describe, expect, it } from "@effect/vitest"
import * as Domain from "@knpkv/codecommit-core/Domain.js"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import {
  ContinuePullRequestConversationRequest,
  PullRequestConversation,
  pullRequestThreadIdentity,
  type RelayPullRequestDockRegistration,
  relaySelectionMatchesRegistration,
  RelaySelectorState
} from "@knpkv/relay-product"
import {
  codeCommitPullRequestHref,
  matchesCodeCommitPullRequestLocator,
  matchesCodeCommitPullRequestRoute
} from "../src/client/codecommit-route.js"
import {
  codeCommitRepositoryAccountIdentity,
  codeCommitRouteAccountIdentity,
  makeCodeCommitRelayConversation,
  makeCodeCommitRelaySelection,
  makeCodeCommitRelayThreadRegistration
} from "../src/client/codecommitRelayDock.js"
import type { PullRequestRelayReviewResponse } from "../src/server/Api.js"

const selection = Schema.decodeUnknownSync(RelaySelectorState)({
  modelId: "configured-default",
  models: [{ id: "configured-default", label: "Configured default" }],
  profileId: "configured-review",
  profiles: [{ id: "configured-review", label: "Configured review" }]
})

const conversation = Schema.decodeUnknownSync(PullRequestConversation)({
  _tag: "codecommit",
  route: {
    accountId: "repository-account",
    href: "/accounts/credential-account/prs/42",
    pullRequestId: "42",
    routeAccountId: "credential-account"
  },
  selection,
  thread: { accountId: "repository-account", pullRequestId: "42", region: "eu-central-1", repositoryName: "payments" }
})

const explainReview: PullRequestRelayReviewResponse = {
  pullRequestId: "42",
  revisionId: "revision-1",
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  kind: "explain",
  profile: {
    id: "explain",
    name: "Explain change",
    kind: "explain",
    provider: "codex",
    harness: "native-codex",
    model: "configured-default",
    skillIds: []
  },
  result: { explanation: "The change keeps provider access on the host.", findings: [], verdict: "Explained." }
}

const continuationRequest = (message: string) =>
  Schema.decodeUnknownSync(ContinuePullRequestConversationRequest)({ conversation, message, selection })

type ReadyRegistration = Extract<RelayPullRequestDockRegistration, { readonly status: "ready" }>

const requireReadyRegistration = (
  registration: RelayPullRequestDockRegistration
): Effect.Effect<ReadyRegistration, never, never> =>
  registration.status === "ready" ? Effect.succeed(registration) : Effect.die("Expected a ready Relay registration")

describe("CodeCommit Relay dock adapter", () => {
  it("keeps the continuation bound to the registered profile and model", () => {
    const registration = makeCodeCommitRelayThreadRegistration({
      available: true,
      context: [],
      continueReview: () => Promise.resolve({ _tag: "completed" }),
      conversation,
      isReviewing: false,
      review: explainReview,
      selectedFindingId: null,
      selection,
      turns: []
    })

    expect(relaySelectionMatchesRegistration(selection, registration)).toBe(true)
    expect(
      relaySelectionMatchesRegistration(
        Schema.decodeUnknownSync(RelaySelectorState)({
          ...selection,
          profileId: "other-profile",
          profiles: [{ id: "other-profile", label: "Other profile" }]
        }),
        registration
      )
    ).toBe(false)
  })

  it("shows the completed profile's concrete model in the dock selector", () => {
    const selected = makeCodeCommitRelaySelection({ id: "thorough", model: "gpt-5.6-luna", name: "Thorough" })

    expect(selected.modelId).toBe("gpt-5.6-luna")
    expect(selected.models).toEqual([{ id: "gpt-5.6-luna", label: "gpt-5.6-luna" }])
  })

  it("uses repository account identity without changing the credential route alias", () => {
    const account = new Domain.Account({
      awsAccountId: "credential-account",
      profile: "dev-administratoraccess",
      region: "eu-central-1",
      repoAccountId: "repository-account"
    })

    expect(codeCommitRepositoryAccountIdentity(account)).toBe("repository-account")
    expect(codeCommitRouteAccountIdentity(account)).toBe("credential-account")
  })

  it("keeps the located repository and region in the redirect route", () => {
    const account = new Domain.Account({
      awsAccountId: "credential-account",
      profile: "dev-administratoraccess",
      region: "eu-central-1",
      repoAccountId: "repository-account"
    })
    const candidate = {
      account,
      id: Domain.PullRequestId.make("42"),
      repositoryName: Domain.RepositoryName.make("payments")
    }

    expect(codeCommitPullRequestHref("credential-account", "42", "payments", "eu-central-1"))
      .toBe("/accounts/credential-account/prs/42?repository=payments&region=eu-central-1")
    expect(matchesCodeCommitPullRequestRoute(candidate, {
      accountId: "credential-account",
      pullRequestId: "42",
      region: "eu-central-1",
      repositoryName: "payments"
    })).toBe(true)
    expect(matchesCodeCommitPullRequestRoute(candidate, {
      accountId: "repository-account",
      pullRequestId: "42",
      region: "eu-central-1",
      repositoryName: "payments"
    })).toBe(false)
    expect(matchesCodeCommitPullRequestLocator(candidate, {
      accountId: "repository-account",
      pullRequestId: "42",
      region: "eu-central-1",
      repositoryName: "payments"
    })).toBe(true)
    expect(matchesCodeCommitPullRequestRoute({ ...candidate, repositoryName: Domain.RepositoryName.make("other") }, {
      accountId: "credential-account",
      pullRequestId: "42",
      region: "eu-central-1",
      repositoryName: "payments"
    })).toBe(false)
  })

  it("keeps regional PRs in separate Relay thread identities", () => {
    const east = Schema.decodeUnknownSync(PullRequestConversation)({
      ...conversation,
      thread: { ...conversation.thread, region: "us-east-1" }
    })
    const west = Schema.decodeUnknownSync(PullRequestConversation)({
      ...conversation,
      thread: { ...conversation.thread, region: "us-west-2" }
    })

    expect(pullRequestThreadIdentity(east)).not.toEqual(pullRequestThreadIdentity(west))
  })

  it("recomputes the canonical thread identity when only the region changes", () => {
    const account = new Domain.Account({
      awsAccountId: "credential-account",
      profile: "dev-administratoraccess",
      region: "us-east-1",
      repoAccountId: "repository-account"
    })
    const pullRequest = {
      account,
      id: Domain.PullRequestId.make("42"),
      repositoryName: Domain.RepositoryName.make("payments")
    }
    const east = makeCodeCommitRelayConversation("credential-account", pullRequest, selection)
    const west = makeCodeCommitRelayConversation(
      "credential-account",
      {
        ...pullRequest,
        account: new Domain.Account({
          awsAccountId: "credential-account",
          profile: "dev-administratoraccess",
          region: "us-west-2",
          repoAccountId: "repository-account"
        })
      },
      selection
    )

    expect(pullRequestThreadIdentity(east)).not.toEqual(pullRequestThreadIdentity(west))
  })

  it.effect("keeps a zero-finding PR review ready and continues at PR scope", () =>
    Effect.gen(function*() {
      const targets: Array<string> = []
      const registration = yield* requireReadyRegistration(makeCodeCommitRelayThreadRegistration({
        available: true,
        context: [],
        continueReview: (target, _message) => {
          targets.push(target)
          return Promise.resolve({ _tag: "completed" })
        },
        conversation,
        isReviewing: false,
        review: explainReview,
        selectedFindingId: null,
        selection,
        turns: []
      }))

      expect(registration.status).toBe("ready")
      const request = continuationRequest("Continue at PR scope.")
      yield* registration.continuePullRequestConversation(request)

      expect(targets).toEqual(["PR"])
      expect(registration.messages.map(({ text }) => text)).toContain(
        "The change keeps provider access on the host."
      )
    }))

  it.effect("surfaces an incomplete continuation as a typed failure", () =>
    Effect.gen(function*() {
      const registration = yield* requireReadyRegistration(makeCodeCommitRelayThreadRegistration({
        available: true,
        context: [],
        continueReview: () => Promise.resolve({ _tag: "failed" }),
        conversation,
        isReviewing: false,
        review: explainReview,
        selectedFindingId: null,
        selection,
        turns: []
      }))

      expect(registration.status).toBe("ready")
      const request = continuationRequest("Keep this message.")
      const failure = yield* registration.continuePullRequestConversation(request).pipe(Effect.flip)

      expect(failure._tag).toBe("PullRequestConversationContinuationFailed")
    }))

  it("blocks continuation while the stored review is stale for the visible head", () => {
    const registration = makeCodeCommitRelayThreadRegistration({
      available: true,
      context: [],
      continueReview: () => Promise.resolve({ _tag: "completed" }),
      conversation,
      isReviewing: false,
      review: explainReview,
      reviewIsStale: true,
      selectedFindingId: null,
      selection,
      turns: []
    })

    expect(registration.status).toBe("unavailable")
    if (registration.status === "unavailable") {
      expect(registration.description).toContain("current exact revision")
    }
  })
})
