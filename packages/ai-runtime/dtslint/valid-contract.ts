import { Stream } from "effect"

import {
  type AgentAdapter,
  AgentProviderError,
  type AgentProviderId,
  type AgentRunId,
  type AgentSessionRef
} from "../src/index.js"

declare const providerId: AgentProviderId
declare const runId: AgentRunId
declare const sessionRef: AgentSessionRef

export const sameRunId: AgentRunId = runId

// @ts-expect-error provider identities cannot be used as durable run identities
export const runIdFromProvider: AgentRunId = providerId

// @ts-expect-error opaque session references cannot be used as durable run identities
export const runIdFromSession: AgentRunId = sessionRef

export const providerFailureAdapter: AgentAdapter = {
  run: () =>
    Stream.fail(
      new AgentProviderError({
        providerId,
        phase: "execution",
        message: "provider stopped",
        retryable: true
      })
    )
}
