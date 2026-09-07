/** Thin Control Center mapping into provider-neutral review contracts. @module */
import type { ReviewExecutionProfile, ReviewThreadIdentity } from "@knpkv/review"

import type { AgentProviderCatalogEntry } from "../../api/agent.js"
import type { EntityId } from "../../domain/identifiers.js"

export interface ControlCenterReviewProvider {
  readonly displayName?: NonNullable<AgentProviderCatalogEntry["displayName"]>
  readonly model: AgentProviderCatalogEntry["models"][number]
  readonly providerId: AgentProviderCatalogEntry["providerId"]
  readonly reviewProfile: NonNullable<AgentProviderCatalogEntry["reviewProfile"]>
}

export interface ControlCenterReviewScope {
  readonly baseRevision: string | null
  readonly entityId: EntityId
  readonly headRevision: string
  readonly sessionKey: string
}

/** Map only browser-safe catalog metadata; credentials and provider locators stay server-local. */
export const controlCenterReviewProfile = (provider: ControlCenterReviewProvider): ReviewExecutionProfile => ({
  id: String(provider.providerId),
  name: provider.displayName ?? String(provider.providerId),
  kind: "review",
  provider: String(provider.providerId),
  harness: provider.reviewProfile.sandbox,
  model: String(provider.model),
  skillIds: []
})

export const controlCenterReviewThread = (scope: ControlCenterReviewScope): ReviewThreadIdentity => ({
  namespace: "control-center",
  subjectId: String(scope.entityId),
  revisionId: scope.sessionKey,
  baseRevision: scope.baseRevision,
  headRevision: scope.headRevision
})
