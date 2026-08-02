/** Stable source-revision baselines attached to governed release publications. @module */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { GovernedActionEnvelopeDigest } from "../../domain/governedAction/index.js"
import { SourceRevision } from "../../domain/sourceRevision.js"
import { digestCanonicalGovernedActionJson } from "../governance/governedActionDigests.js"

/** Hash the complete encoded source-revision snapshot used by a release publication. */
export const digestReleaseSourceRevisions = Effect.fn("ReleasePublicationMetadata.digestSourceRevisions")(
  function*(sourceRevisions: ReadonlyArray<typeof SourceRevision.Type>) {
    const encoded = yield* Schema.encodeEffect(Schema.Array(SourceRevision))(sourceRevisions)
    const json = yield* Schema.decodeUnknownEffect(Schema.Json)(encoded)
    const digest = yield* digestCanonicalGovernedActionJson(json)
    return GovernedActionEnvelopeDigest.make(`sha256:${digest}`)
  }
)
