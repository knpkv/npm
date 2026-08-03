/** Stable source-revision baselines attached to governed release publications. @module */
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { GovernedActionEnvelopeDigest } from "../../domain/governedAction/index.js"
import type { ReleaseId } from "../../domain/identifiers.js"
import { SourceRevision } from "../../domain/sourceRevision.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import { digestCanonicalGovernedActionJson } from "../governance/governedActionDigests.js"

export interface ReleasePublicationReceiptCandidate {
  readonly releaseId: ReleaseId
  readonly occurredAt: UtcTimestamp
  readonly providerOperationId: string
}

export interface ConfluencePublicationReference {
  readonly pageId: string
  readonly pageVersion: number
}

export interface LatestConfluencePublicationReference extends ConfluencePublicationReference {
  readonly publishedAt: UtcTimestamp
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
  return reference === null ? null : { ...reference, publishedAt: latest.occurredAt }
}

/** Hash the complete encoded source-revision snapshot used by a release publication. */
export const digestReleaseSourceRevisions = Effect.fn("ReleasePublicationMetadata.digestSourceRevisions")(
  function*(sourceRevisions: ReadonlyArray<typeof SourceRevision.Type>) {
    const encoded = yield* Schema.encodeEffect(Schema.Array(SourceRevision))(sourceRevisions)
    const json = yield* Schema.decodeUnknownEffect(Schema.Json)(encoded)
    const digest = yield* digestCanonicalGovernedActionJson(json)
    return GovernedActionEnvelopeDigest.make(`sha256:${digest}`)
  }
)
