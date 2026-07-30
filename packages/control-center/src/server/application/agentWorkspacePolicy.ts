/** Shared workspace-policy assertions for agent admission boundaries. @module */
import * as Effect from "effect/Effect"

import type { WorkspaceSettingsV1 } from "../../domain/workspaceSettings.js"
import { ApplicationInvalidRequest } from "../api/ApplicationServices.js"

type AgentSettings = typeof WorkspaceSettingsV1.Type["agent"]

/** Reject a provider that is not admitted by the workspace's durable policy. */
export const assertAgentProviderAllowed = (
  settings: AgentSettings,
  providerId: string
): Effect.Effect<void, ApplicationInvalidRequest> =>
  settings.allowedProviders.some((allowedProvider) => allowedProvider === providerId)
    ? Effect.void
    : Effect.fail(new ApplicationInvalidRequest())

/** Reject pull-request review when the workspace has not enabled sandbox review tools. */
export const assertPullRequestReviewAllowed = (
  settings: AgentSettings
): Effect.Effect<void, ApplicationInvalidRequest> =>
  settings.toolPolicy === "review-sandbox"
    ? Effect.void
    : Effect.fail(new ApplicationInvalidRequest())
