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
  codeCommitRelayAbout,
  codeCommitRelayAccountKind,
  codeCommitRelayExecutionProfile,
  codeCommitRepositoryAccountIdentity,
  codeCommitRouteAccountIdentity,
  makeCodeCommitRelayConversation,
  makeCodeCommitRelaySelection,
  makeCodeCommitRelayThreadRegistration,
  relayModelLabel
} from "../src/client/codecommitRelayDock.js"
import { type PullRequestRelayReviewResponse, RelayReviewFinding } from "../src/server/Api.js"

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
  pullRequestId: Domain.PullRequestId.make("42"),
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

const retryFinding = Schema.decodeUnknownSync(RelayReviewFinding)({
  details: "Each retry re-enqueues the job.",
  id: "F1",
  location: { scope: "general" },
  priority: "P2",
  publicationTarget: "pr-comment",
  recommendation: "Bound the retries.",
  summary: "Retries multiply under load.",
  title: "Retry amplification",
  verification: "Load test the queue."
})

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

  it("keeps dock continuation on the completed profile after the main selector changes", () => {
    const selected = { id: "security", model: "configured-default", name: "Security review" }

    expect(codeCommitRelayExecutionProfile(explainReview, selected)).toEqual(explainReview.profile)
  })

  it("uses repository account identity without changing the credential route alias", () => {
    const account = new Domain.Account({
      awsAccountId: "credential-account",
      profile: Domain.AwsProfileName.make("dev-administratoraccess"),
      region: Domain.AwsRegion.make("eu-central-1"),
      repoAccountId: "repository-account"
    })

    expect(codeCommitRepositoryAccountIdentity(account)).toBe("repository-account")
    expect(codeCommitRelayAccountKind(account)).toBe("repository")
    expect(codeCommitRouteAccountIdentity(account)).toBe("credential-account")
  })

  it("uses the credential account when repository identity is empty", () => {
    const account = new Domain.Account({
      awsAccountId: "credential-account",
      profile: Domain.AwsProfileName.make("dev-administratoraccess"),
      region: Domain.AwsRegion.make("eu-central-1"),
      repoAccountId: ""
    })

    expect(codeCommitRepositoryAccountIdentity(account)).toBe("credential-account")
    expect(codeCommitRelayAccountKind(account)).toBe("credential")
    expect(
      makeCodeCommitRelayConversation(
        "credential-account",
        {
          account,
          id: Domain.PullRequestId.make("42"),
          repositoryName: Domain.RepositoryName.make("payments")
        },
        selection
      ).thread
    ).toMatchObject({ accountId: "credential-account" })
    expect(
      codeCommitRouteAccountIdentity(
        new Domain.Account({
          awsAccountId: "",
          profile: Domain.AwsProfileName.make("dev-administratoraccess"),
          region: Domain.AwsRegion.make("eu-central-1"),
          repoAccountId: ""
        })
      )
    ).toBe("dev-administratoraccess")
  })

  it("keeps the located repository and region in the redirect route", () => {
    const account = new Domain.Account({
      awsAccountId: "credential-account",
      profile: Domain.AwsProfileName.make("dev-administratoraccess"),
      region: Domain.AwsRegion.make("eu-central-1"),
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
      accountId: "credential-account",
      pullRequestId: "42"
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
      profile: Domain.AwsProfileName.make("dev-administratoraccess"),
      region: Domain.AwsRegion.make("us-east-1"),
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
          profile: Domain.AwsProfileName.make("dev-administratoraccess"),
          region: Domain.AwsRegion.make("us-west-2"),
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

  it.effect("names what each run of turns is about, so per-finding discussions stay readable in one thread", () =>
    Effect.gen(function*() {
      const onClear = (): void => undefined
      const registration = yield* requireReadyRegistration(
        makeCodeCommitRelayThreadRegistration({
          about: { id: "F1", label: "Finding: Retry amplification", onClear },
          available: true,
          context: [],
          continueReview: () => Promise.resolve({ _tag: "completed" }),
          conversation,
          isReviewing: false,
          review: {
            ...explainReview,
            result: {
              ...explainReview.result,
              findings: [retryFinding]
            }
          },
          selectedFindingId: "F1",
          selection,
          turns: [
            { id: "t1", findingId: "F1", role: "user", message: "Is it bounded?" },
            { id: "t2", findingId: "F1", role: "assistant", message: "Yes, three attempts." },
            { id: "t3", findingId: "F9", role: "user", message: "And the old one?" },
            { id: "t4", findingId: "PR", role: "user", message: "Anything else?" }
          ]
        })
      )
      expect(registration.about?.label).toBe("Finding: Retry amplification")
      expect(registration.messages.filter(({ role }) => role === "system").map(({ text }) => text)).toEqual([
        "About Retry amplification",
        "About F9, no longer in the current deck",
        "About the whole pull request"
      ])
      // Verdict and explanation, then each run of turns after the note naming it.
      expect(registration.messages.map(({ role }) => role)).toEqual([
        "relay",
        "relay",
        "system",
        "operator",
        "relay",
        "system",
        "operator",
        "system",
        "operator"
      ])
    }))

  it("names the discussed finding by its whole snapshot, so a changed finding under a reused id is a new context", () => {
    const onClear = (): void => undefined
    const review = { ...explainReview, result: { ...explainReview.result, findings: [retryFinding] } }
    const changed = {
      ...review,
      result: { ...review.result, findings: [{ ...retryFinding, summary: "Retries now back off." }] }
    }
    const before = codeCommitRelayAbout("F1", review, onClear)
    const after = codeCommitRelayAbout("F1", changed, onClear)
    expect(before?.label).toBe("Finding: Retry amplification")
    expect(after?.label).toBe("Finding: Retry amplification")
    expect(after?.id).not.toBe(before?.id)
    expect(codeCommitRelayAbout("F1", null, onClear)).toMatchObject({ id: "F1", label: "Finding: F1" })
    expect(codeCommitRelayAbout(null, review, onClear)).toBeUndefined()
  })

  it("names the provider's default model in words, never by its raw id", () => {
    expect(relayModelLabel("configured-default")).toBe("Default model")
    expect(relayModelLabel("default")).toBe("Default model")
    expect(relayModelLabel(undefined)).toBe("Default model")
    expect(relayModelLabel("gpt-5.6-luna")).toBe("gpt-5.6-luna")
    expect(
      makeCodeCommitRelaySelection({ id: "thorough", model: "configured-default", name: "Thorough review" }).models
    ).toEqual([{ id: "configured-default", label: "Default model" }])
  })
})
