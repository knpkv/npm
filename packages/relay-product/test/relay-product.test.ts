import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"

import {
  ContinuePullRequestConversationRequest,
  InvalidRelaySelectorState,
  makeInitialRelayState,
  makeRelayProductAdapter,
  ProductAuthorization,
  PullRequestConversation,
  PullRequestConversationContinuation,
  PullRequestConversationLocator,
  pullRequestThreadIdentity,
  RelayAuthenticationRequired,
  RelayProductAdapterContractError,
  RelayProductContinuationReceiptMismatch,
  type RelayProductPort
} from "../src/index.js"

const selectionFixture = {
  modelId: "claude-sonnet",
  models: [{ id: "claude-sonnet", label: "Claude Sonnet" }],
  profileId: "secure-review",
  profiles: [{ id: "secure-review", label: "Secure review" }]
}

const locatePaymentsPr184 = Schema.decodeUnknownEffect(PullRequestConversationLocator)({
  provider: "codecommit",
  pullRequestId: "184",
  region: "eu-west-1",
  repositoryName: "payments"
})

describe("Relay product adapter", () => {
  it.effect("starts collapsed with an explicit profile and model", () =>
    Effect.gen(function*() {
      const state = yield* makeInitialRelayState({
        ...selectionFixture
      })

      expect(state).toEqual({
        dock: { _tag: "collapsed" },
        selection: {
          modelId: "claude-sonnet",
          models: [{ id: "claude-sonnet", label: "Claude Sonnet" }],
          profileId: "secure-review",
          profiles: [{ id: "secure-review", label: "Secure review" }]
        }
      })
    }))

  it.effect("rejects duplicate visible profile identities", () =>
    Effect.gen(function*() {
      const failure = yield* makeInitialRelayState({
        ...selectionFixture,
        profiles: [
          { id: "secure-review", label: "Secure review" },
          { id: "secure-review", label: "Security review duplicate" }
        ]
      }).pipe(Effect.flip)

      expect(failure).toEqual(new InvalidRelaySelectorState({ reason: "duplicate-profile" }))
    }))

  it.effect("locates a Control Center PR thread and redirects to its exact page", () =>
    Effect.gen(function*() {
      const authorization = yield* Schema.decodeUnknownEffect(ProductAuthorization)({
        _tag: "control-center",
        principalId: "operator",
        workspaceId: "019c3df0-1111-7000-8000-000000000001"
      })
      const conversation = yield* Schema.decodeUnknownEffect(PullRequestConversation)({
        _tag: "control-center",
        route: {
          entityId: "019c3df0-2222-7000-8000-000000000002",
          href: "/w/019c3df0-1111-7000-8000-000000000001/items/019c3df0-2222-7000-8000-000000000002"
        },
        selection: selectionFixture,
        thread: {
          pluginConnectionId: "019c3df0-3333-7000-8000-000000000003",
          pullRequestId: "184",
          repositoryName: "payments",
          workspaceId: "019c3df0-1111-7000-8000-000000000001"
        }
      })
      const redirected = yield* Ref.make<PullRequestConversation | null>(null)
      const port: RelayProductPort = {
        authorize: () => Effect.succeed(authorization),
        continuePullRequestConversation: () => Effect.die("continuation is outside this test"),
        locatePullRequestConversation: () => Effect.succeed(conversation),
        product: "control-center",
        redirectToPullRequest: (target) => Ref.set(redirected, target)
      }
      const adapter = makeRelayProductAdapter(port)

      const locator = yield* locatePaymentsPr184
      const located = yield* adapter.openPullRequestConversation(locator)

      expect(located.route.href).toBe(
        "/w/019c3df0-1111-7000-8000-000000000001/items/019c3df0-2222-7000-8000-000000000002"
      )
      expect(yield* Ref.get(redirected)).toEqual(conversation)
    }))

  it.effect("keys durable threads by product scope and PR, never by head revision", () =>
    Effect.gen(function*() {
      const first = yield* Schema.decodeUnknownEffect(PullRequestConversation)({
        _tag: "codecommit",
        route: {
          accountId: "123456789012",
          href: "/accounts/123456789012/prs/184",
          pullRequestId: "184"
        },
        selection: selectionFixture,
        thread: {
          accountId: "123456789012",
          pullRequestId: "184",
          repositoryName: "payments"
        }
      })
      const second = yield* Schema.decodeUnknownEffect(PullRequestConversation)({
        _tag: "codecommit",
        route: {
          accountId: "123456789012",
          href: "/accounts/123456789012/prs/185",
          pullRequestId: "185"
        },
        selection: selectionFixture,
        thread: {
          accountId: "123456789012",
          pullRequestId: "185",
          repositoryName: "payments"
        }
      })

      expect(pullRequestThreadIdentity(first)).toEqual({
        _tag: "codecommit",
        accountId: "123456789012",
        pullRequestId: "184",
        repositoryName: "payments"
      })
      expect(pullRequestThreadIdentity(second)).not.toEqual(pullRequestThreadIdentity(first))
      expect("headRevision" in pullRequestThreadIdentity(first)).toBe(false)
    }))

  it.effect("continues the exact CodeCommit thread with the visible selector", () =>
    Effect.gen(function*() {
      const authorization = yield* Schema.decodeUnknownEffect(ProductAuthorization)({
        _tag: "codecommit",
        principalId: "owner"
      })
      const conversation = yield* Schema.decodeUnknownEffect(PullRequestConversation)({
        _tag: "codecommit",
        route: {
          accountId: "123456789012",
          href: "/accounts/123456789012/prs/184",
          pullRequestId: "184"
        },
        selection: selectionFixture,
        thread: {
          accountId: "123456789012",
          pullRequestId: "184",
          repositoryName: "payments"
        }
      })
      const request = yield* Schema.decodeUnknownEffect(ContinuePullRequestConversationRequest)({
        conversation,
        message: "Continue the security review on this PR.",
        selection: selectionFixture
      })
      const receipt = yield* Schema.decodeUnknownEffect(PullRequestConversationContinuation)({
        messageId: "message-41",
        thread: pullRequestThreadIdentity(conversation)
      })
      const continued = yield* Ref.make<ContinuePullRequestConversationRequest | null>(null)
      const port: RelayProductPort = {
        authorize: () => Effect.succeed(authorization),
        continuePullRequestConversation: (_authorization, input) => Ref.set(continued, input).pipe(Effect.as(receipt)),
        locatePullRequestConversation: () => Effect.die("lookup is outside this test"),
        product: "codecommit",
        redirectToPullRequest: () => Effect.die("redirect is outside this test")
      }

      const result = yield* makeRelayProductAdapter(port).continuePullRequestConversation(request)

      expect(result).toEqual(receipt)
      expect(yield* Ref.get(continued)).toEqual(request)
    }))

  it.effect("returns the product auth failure without attempting a fallback", () =>
    Effect.gen(function*() {
      const locator = yield* locatePaymentsPr184
      const port: RelayProductPort = {
        authorize: (operation) => Effect.fail(new RelayAuthenticationRequired({ operation, product: "codecommit" })),
        continuePullRequestConversation: () => Effect.die("continuation must not run"),
        locatePullRequestConversation: () => Effect.die("lookup must not run"),
        product: "codecommit",
        redirectToPullRequest: () => Effect.die("redirect must not run")
      }

      const failure = yield* makeRelayProductAdapter(port).openPullRequestConversation(locator).pipe(Effect.flip)

      expect(failure).toEqual(
        new RelayAuthenticationRequired({
          operation: "locate-pull-request-conversation",
          product: "codecommit"
        })
      )
    }))

  it.effect("rejects a cross-product continuation before the product transport", () =>
    Effect.gen(function*() {
      const authorization = yield* Schema.decodeUnknownEffect(ProductAuthorization)({
        _tag: "codecommit",
        principalId: "owner"
      })
      const conversation = yield* Schema.decodeUnknownEffect(PullRequestConversation)({
        _tag: "control-center",
        route: {
          entityId: "019c3df0-2222-7000-8000-000000000002",
          href: "/w/019c3df0-1111-7000-8000-000000000001/items/019c3df0-2222-7000-8000-000000000002"
        },
        selection: selectionFixture,
        thread: {
          pluginConnectionId: "019c3df0-3333-7000-8000-000000000003",
          pullRequestId: "184",
          repositoryName: "payments",
          workspaceId: "019c3df0-1111-7000-8000-000000000001"
        }
      })
      const request = yield* Schema.decodeUnknownEffect(ContinuePullRequestConversationRequest)({
        conversation,
        message: "Continue this PR thread.",
        selection: selectionFixture
      })
      const port: RelayProductPort = {
        authorize: () => Effect.succeed(authorization),
        continuePullRequestConversation: () => Effect.die("cross-product continuation must not run"),
        locatePullRequestConversation: () => Effect.die("lookup is outside this test"),
        product: "codecommit",
        redirectToPullRequest: () => Effect.die("redirect is outside this test")
      }

      const failure = yield* makeRelayProductAdapter(port).continuePullRequestConversation(request).pipe(Effect.flip)

      expect(failure).toEqual(
        new RelayProductAdapterContractError({
          actualProduct: "control-center",
          expectedProduct: "codecommit",
          operation: "continue-pull-request-conversation"
        })
      )
    }))

  it.effect("rejects a continuation receipt for another PR thread", () =>
    Effect.gen(function*() {
      const authorization = yield* Schema.decodeUnknownEffect(ProductAuthorization)({
        _tag: "codecommit",
        principalId: "owner"
      })
      const conversation = yield* Schema.decodeUnknownEffect(PullRequestConversation)({
        _tag: "codecommit",
        route: {
          accountId: "123456789012",
          href: "/accounts/123456789012/prs/184",
          pullRequestId: "184"
        },
        selection: selectionFixture,
        thread: {
          accountId: "123456789012",
          pullRequestId: "184",
          repositoryName: "payments"
        }
      })
      const request = yield* Schema.decodeUnknownEffect(ContinuePullRequestConversationRequest)({
        conversation,
        message: "Continue this PR thread.",
        selection: selectionFixture
      })
      const wrongReceipt = yield* Schema.decodeUnknownEffect(PullRequestConversationContinuation)({
        messageId: "message-42",
        thread: {
          ...pullRequestThreadIdentity(conversation),
          pullRequestId: "185"
        }
      })
      const port: RelayProductPort = {
        authorize: () => Effect.succeed(authorization),
        continuePullRequestConversation: () => Effect.succeed(wrongReceipt),
        locatePullRequestConversation: () => Effect.die("lookup is outside this test"),
        product: "codecommit",
        redirectToPullRequest: () => Effect.die("redirect is outside this test")
      }

      const failure = yield* makeRelayProductAdapter(port).continuePullRequestConversation(request).pipe(Effect.flip)

      expect(failure).toEqual(
        new RelayProductContinuationReceiptMismatch({
          actualThread: wrongReceipt.thread,
          expectedThread: pullRequestThreadIdentity(conversation)
        })
      )
    }))
})
