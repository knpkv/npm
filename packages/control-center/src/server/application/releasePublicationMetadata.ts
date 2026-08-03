/** Stable source-revision baselines attached to governed release publications. @module */
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { GovernedActionEnvelopeDigest } from "../../domain/governedAction/index.js"
import type { PluginConnectionId, ReleaseId } from "../../domain/identifiers.js"
import type { SourceRevision } from "../../domain/sourceRevision.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import { digestCanonicalGovernedActionJson } from "../governance/governedActionDigests.js"

export interface ReleasePublicationReceiptCandidate {
  readonly releaseId: ReleaseId
  readonly pluginConnectionId: PluginConnectionId
  readonly occurredAt: UtcTimestamp
  readonly providerOperationId: string
}

export interface ConfluencePublicationReference {
  readonly pageId: string
  readonly pageVersion: number
}

export interface LatestConfluencePublicationReference extends ConfluencePublicationReference {
  readonly pluginConnectionId: PluginConnectionId
  readonly publishedAt: UtcTimestamp
}

export type ReleasePublicationConnectionSelection =
  | { readonly _tag: "selected"; readonly pluginConnectionId: PluginConnectionId }
  | { readonly _tag: "ambiguous" }
  | { readonly _tag: "missing" }

/** Select one explicit publication authority without relying on display ordering. */
export const selectReleasePublicationConnection = (input: {
  readonly enabledConnectionIds: ReadonlyArray<PluginConnectionId>
  readonly publicationReceiptConnectionId?: PluginConnectionId
  readonly releaseSourceConnectionId?: PluginConnectionId
}): ReleasePublicationConnectionSelection => {
  if (
    input.releaseSourceConnectionId !== undefined &&
    input.publicationReceiptConnectionId !== undefined &&
    input.releaseSourceConnectionId !== input.publicationReceiptConnectionId
  ) return { _tag: "ambiguous" }
  const boundConnectionId = input.releaseSourceConnectionId ?? input.publicationReceiptConnectionId
  if (boundConnectionId !== undefined) {
    return { _tag: "selected", pluginConnectionId: boundConnectionId }
  }
  if (input.enabledConnectionIds.length === 1) {
    const pluginConnectionId = input.enabledConnectionIds[0]
    return pluginConnectionId === undefined
      ? { _tag: "missing" }
      : { _tag: "selected", pluginConnectionId }
  }
  return input.enabledConnectionIds.length === 0 ? { _tag: "missing" } : { _tag: "ambiguous" }
}

/** Require a client update target to equal the exact durable publication receipt. */
export const matchesConfluencePublicationReference = (
  published: ConfluencePublicationReference | null,
  requested: ConfluencePublicationReference
): boolean =>
  published !== null &&
  published.pageId === requested.pageId &&
  published.pageVersion === requested.pageVersion

/** Decode the provider receipt identity persisted after a successful Confluence publication. */
export const decodeConfluencePublicationReference = (
  providerOperationId: string
): ConfluencePublicationReference | null => {
  const match = /^confluence-page:([1-9][0-9]*)(?::v([1-9][0-9]*))?$/u.exec(providerOperationId)
  const pageId = match?.[1]
  return pageId === undefined ? null : { pageId, pageVersion: Number(match?.[2] ?? "1") }
}

/** Resolve the exact latest successful Confluence page receipt for one release. */
export const latestConfluencePublicationReference = (
  candidates: ReadonlyArray<ReleasePublicationReceiptCandidate>,
  releaseId: ReleaseId
): LatestConfluencePublicationReference | null => {
  const latest = candidates
    .filter((candidate) => candidate.releaseId === releaseId)
    .sort((left, right) => DateTime.Order(right.occurredAt, left.occurredAt))
    .find(({ providerOperationId }) => decodeConfluencePublicationReference(providerOperationId) !== null)
  if (latest === undefined) return null
  const reference = decodeConfluencePublicationReference(latest.providerOperationId)
  return reference === null
    ? null
    : {
      ...reference,
      pluginConnectionId: latest.pluginConnectionId,
      publishedAt: latest.occurredAt
    }
}

/** Hash stable source identity and semantic revisions used by a release publication. */
export const digestReleaseSourceRevisions = Effect.fn("ReleasePublicationMetadata.digestSourceRevisions")(
  function*(sourceRevisions: ReadonlyArray<typeof SourceRevision.Type>) {
    const stableRevisions = sourceRevisions
      .map((sourceRevision) => ({
        normalizationSchemaVersion: sourceRevision.normalizationSchemaVersion,
        pluginConnectionId: sourceRevision.pluginConnectionId,
        providerId: sourceRevision.providerId,
        revision: sourceRevision.revision,
        vendorImmutableId: sourceRevision.vendorImmutableId
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    const json = yield* Schema.decodeUnknownEffect(Schema.Json)(stableRevisions)
    const digest = yield* digestCanonicalGovernedActionJson(json)
    return GovernedActionEnvelopeDigest.make(`sha256:${digest}`)
  }
)
