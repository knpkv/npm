import { describe, expect, it } from "@effect/vitest"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import {
  ContinuePullRequestConversationRequest,
  PullRequestConversation,
  PullRequestConversationContinuationFailed,
  RelaySelectorState
} from "@knpkv/relay-product"
import { DurableAgentProviderId } from "../../src/api/agent.js"
import { continueControlCenterRelayConversation } from "../../src/client/controlCenterRelayThread.js"

class EnqueueFailure extends Data.TaggedError("EnqueueFailure") {}

const selection = Schema.decodeUnknownSync(RelaySelectorState)({
  modelId: "configured-model",
  models: [{ id: "configured-model", label: "Configured model" }],
  profileId: "configured-profile",
  profiles: [{ id: "configured-profile", label: "Configured profile" }]
})

const conversation = Schema.decodeUnknownSync(PullRequestConversation)({
  _tag: "control-center",
  route: {
    entityId: "019c3df0-2222-7000-8000-000000000002",
    href: "/w/019c3df0-2222-7000-8000-000000000001/items/019c3df0-2222-7000-8000-000000000002"
  },
  selection,
  thread: {
    pluginConnectionId: "019c3df0-2222-7000-8000-000000000003",
    pullRequestId: "42",
    repositoryName: "payments",
    workspaceId: "019c3df0-2222-7000-8000-000000000001"
  }
})

const request = Schema.decodeUnknownSync(ContinuePullRequestConversationRequest)({
  conversation,
  message: "Continue this pull-request thread.",
  selection
})

describe("Control Center Relay continuation", () => {
  it.effect("reports an enqueue rejection to the shared dock", () =>
    Effect.gen(function*() {
      const failure = yield* continueControlCenterRelayConversation({
        conversation,
        providerId: DurableAgentProviderId.make("openai-compatible"),
        request,
        startReview: () => Promise.reject(new EnqueueFailure())
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PullRequestConversationContinuationFailed)
      expect(failure).toMatchObject({
        product: "control-center",
        thread: {
          _tag: "control-center",
          pullRequestId: "42",
          repositoryName: "payments",
          workspaceId: "019c3df0-2222-7000-8000-000000000001"
        }
      })
    }))

  it.effect("accepts a resolving enqueue so the shared dock can clear its submitted message", () =>
    Effect.gen(function*() {
      const received: Array<string> = []
      yield* continueControlCenterRelayConversation({
        conversation,
        providerId: DurableAgentProviderId.make("openai-compatible"),
        request,
        startReview: (prompt) => {
          if (prompt !== undefined) received.push(prompt)
          return Promise.resolve()
        }
      })

      expect(received).toEqual([request.message])
    }))
})
