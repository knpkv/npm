import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Schema from "effect/Schema"

import {
  EnvironmentReadinessCandidateMaterial,
  normalizeEnvironmentReadinessCandidateMaterial,
  normalizeReadinessRuleMaterial,
  normalizeReleaseReadinessCandidateMaterial,
  ReadinessCandidateDigest,
  type ReadinessRuleMaterial,
  ReadinessRuleMaterial as ReadinessRuleMaterialSchema,
  ReleaseReadinessCandidateMaterial
} from "../domain/readiness/index.js"

/** Bounded server failure while producing a canonical readiness digest. */
export class ReadinessDigestError extends Schema.TaggedErrorClass<ReadinessDigestError>()("ReadinessDigestError", {
  operation: Schema.Literals(["encode", "encode-utf8", "digest"])
}) {}

const environmentMaterialJson = Schema.fromJsonString(EnvironmentReadinessCandidateMaterial)
const releaseMaterialJson = Schema.fromJsonString(ReleaseReadinessCandidateMaterial)
const ruleMaterialJson = Schema.fromJsonString(ReadinessRuleMaterialSchema)

const encodeEnvironmentMaterial = Schema.encodeEffect(environmentMaterialJson)
const encodeReleaseMaterial = Schema.encodeEffect(releaseMaterialJson)
const encodeRuleMaterial = Schema.encodeEffect(ruleMaterialJson)

const digestCanonicalJson = Effect.fn("ReadinessDigests.digestCanonicalJson")(function*(value: string) {
  const cryptoService = yield* Crypto.Crypto
  const bytes = yield* Effect.fromResult(Encoding.decodeBase64(Encoding.encodeBase64(value))).pipe(
    Effect.mapError(() => new ReadinessDigestError({ operation: "encode-utf8" }))
  )
  const digest = yield* cryptoService
    .digest("SHA-256", bytes)
    .pipe(Effect.mapError(() => new ReadinessDigestError({ operation: "digest" })))
  return ReadinessCandidateDigest.make(`sha256:${Encoding.encodeHex(digest)}`)
})

/** Hash the complete environment candidate after deterministic nested normalization. */
export const digestEnvironmentReadinessCandidate = Effect.fn("ReadinessDigests.environmentCandidate")(function*(
  material: EnvironmentReadinessCandidateMaterial
) {
  const value = yield* encodeEnvironmentMaterial(normalizeEnvironmentReadinessCandidateMaterial(material)).pipe(
    Effect.mapError(() => new ReadinessDigestError({ operation: "encode" }))
  )
  return yield* digestCanonicalJson(value)
})

/** Hash the exact set of child assessments forming a release candidate. */
export const digestReleaseReadinessCandidate = Effect.fn("ReadinessDigests.releaseCandidate")(function*(
  material: ReleaseReadinessCandidateMaterial
) {
  const value = yield* encodeReleaseMaterial(normalizeReleaseReadinessCandidateMaterial(material)).pipe(
    Effect.mapError(() => new ReadinessDigestError({ operation: "encode" }))
  )
  return yield* digestCanonicalJson(value)
})

/** Hash a complete immutable readiness-rule snapshot. */
export const digestReadinessRule = Effect.fn("ReadinessDigests.rule")(function*(material: ReadinessRuleMaterial) {
  const value = yield* encodeRuleMaterial(normalizeReadinessRuleMaterial(material)).pipe(
    Effect.mapError(() => new ReadinessDigestError({ operation: "encode" }))
  )
  return yield* digestCanonicalJson(value)
})
