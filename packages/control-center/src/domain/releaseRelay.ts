import { Schema } from "effect"
import type { ReleaseId } from "./identifiers.js"

/** Canonical persisted algorithm label for the current Release Relay projection. */
export const RELEASE_RELAY_ALGORITHM = "relay/v1"

/** Explicit v1 alias retained beside the versioned catalog constants. */
export const RELEASE_RELAY_V1_ALGORITHM = RELEASE_RELAY_ALGORITHM

type RelayCatalog = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string
]

const freezeCatalog = <const Catalog extends RelayCatalog>(catalog: Catalog): Readonly<Catalog> =>
  Object.freeze(catalog)

/** Frozen adjective catalog whose order is part of the relay/v1 contract. */
export const RELEASE_RELAY_V1_ADJECTIVES = freezeCatalog([
  "Amber",
  "Azure",
  "Copper",
  "Ember",
  "Golden",
  "Lunar",
  "Moss",
  "Nova",
  "Quiet",
  "Silver",
  "Solar",
  "Tidal",
  "Velvet",
  "Verdant",
  "Wild",
  "Winter"
])

/** Frozen noun catalog whose order is part of the relay/v1 contract. */
export const RELEASE_RELAY_V1_NOUNS = freezeCatalog([
  "Anchor",
  "Beacon",
  "Bridge",
  "Comet",
  "Finch",
  "Fork",
  "Gate",
  "Grove",
  "Harbor",
  "Orbit",
  "Pulse",
  "Reef",
  "Relay",
  "Spark",
  "Wave",
  "Willow"
])

/** Schema for the relay/v1 algorithm discriminator. */
export const ReleaseRelayAlgorithm = Schema.Literal(RELEASE_RELAY_ALGORITHM)

/** Persisted relay/v1 adjective. */
export const ReleaseRelayAdjective = Schema.Literals(RELEASE_RELAY_V1_ADJECTIVES)

/** Persisted relay/v1 noun. */
export const ReleaseRelayNoun = Schema.Literals(RELEASE_RELAY_V1_NOUNS)

/** Persisted relay/v1 codename assembled from the frozen catalogs. */
export const ReleaseRelayCodename = Schema.TemplateLiteral([ReleaseRelayAdjective, " ", ReleaseRelayNoun])

/** Closed index into rly's separately versioned 16-symbol presentation catalog. */
export const ReleaseRelaySymbolIndex = Schema.Literals([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])

/** Decoded relay/v1 symbol index. */
export type ReleaseRelaySymbolIndex = typeof ReleaseRelaySymbolIndex.Type

/** Exactly three distinct persisted indices into the release-symbol catalog. */
export const ReleaseRelaySymbolIndices = Schema.Tuple([
  ReleaseRelaySymbolIndex,
  ReleaseRelaySymbolIndex,
  ReleaseRelaySymbolIndex
]).check(Schema.isUnique({ expected: "three distinct release symbol indices" }))

/** Decoded three-symbol relay projection. */
export type ReleaseRelaySymbolIndices = typeof ReleaseRelaySymbolIndices.Type

/** Versioned, persisted Release Relay identity owned by the Control Center domain. */
export const ReleaseRelayProjection = Schema.Struct({
  algorithm: ReleaseRelayAlgorithm,
  codename: ReleaseRelayCodename,
  symbolIndices: ReleaseRelaySymbolIndices
})

/** Decoded versioned Release Relay projection. */
export type ReleaseRelayProjection = typeof ReleaseRelayProjection.Type

const FNV_1A_OFFSET_BASIS = 0x81_1c_9d_c5
const FNV_1A_PRIME = 0x01_00_01_93

const fnv1a32 = (asciiValue: string): number => {
  let hash = FNV_1A_OFFSET_BASIS
  for (let index = 0; index < asciiValue.length; index += 1) {
    hash ^= asciiValue.charCodeAt(index)
    hash = Math.imul(hash, FNV_1A_PRIME) >>> 0
  }
  return hash
}

const symbolIndexFromRemainder = (remainder: number): ReleaseRelaySymbolIndex => {
  switch (remainder) {
    case 0:
      return 0
    case 1:
      return 1
    case 2:
      return 2
    case 3:
      return 3
    case 4:
      return 4
    case 5:
      return 5
    case 6:
      return 6
    case 7:
      return 7
    case 8:
      return 8
    case 9:
      return 9
    case 10:
      return 10
    case 11:
      return 11
    case 12:
      return 12
    case 13:
      return 13
    case 14:
      return 14
    default:
      return 15
  }
}

const catalogValueAt = <const Catalog extends RelayCatalog>(
  catalog: Catalog,
  index: ReleaseRelaySymbolIndex
): Catalog[number] => {
  switch (index) {
    case 0:
      return catalog[0]
    case 1:
      return catalog[1]
    case 2:
      return catalog[2]
    case 3:
      return catalog[3]
    case 4:
      return catalog[4]
    case 5:
      return catalog[5]
    case 6:
      return catalog[6]
    case 7:
      return catalog[7]
    case 8:
      return catalog[8]
    case 9:
      return catalog[9]
    case 10:
      return catalog[10]
    case 11:
      return catalog[11]
    case 12:
      return catalog[12]
    case 13:
      return catalog[13]
    case 14:
      return catalog[14]
    default:
      return catalog[15]
  }
}

const deriveSymbolIndices = (releaseId: ReleaseId): ReleaseRelaySymbolIndices => {
  const firstIndex = symbolIndexFromRemainder(fnv1a32(`${RELEASE_RELAY_ALGORITHM}|symbol/0|${releaseId}`) % 16)

  const secondRank = fnv1a32(`${RELEASE_RELAY_ALGORITHM}|symbol/1|${releaseId}`) % 15
  const secondIndex = symbolIndexFromRemainder(secondRank < firstIndex ? secondRank : secondRank + 1)

  const lowerExcludedIndex = Math.min(firstIndex, secondIndex)
  const upperExcludedIndex = Math.max(firstIndex, secondIndex)
  const thirdRank = fnv1a32(`${RELEASE_RELAY_ALGORITHM}|symbol/2|${releaseId}`) % 14
  const thirdIndex = symbolIndexFromRemainder(
    thirdRank < lowerExcludedIndex ? thirdRank : thirdRank < upperExcludedIndex - 1 ? thirdRank + 1 : thirdRank + 2
  )

  return [firstIndex, secondIndex, thirdIndex]
}

/**
 * Derive the stable relay/v1 projection for one canonical immutable release identifier.
 *
 * relay/v1 applies unsigned 32-bit FNV-1a to the ASCII domains
 * `relay/v1|adjective|<release-id>`, `relay/v1|noun|<release-id>`, and
 * `relay/v1|symbol/<position>|<release-id>`. Symbol hashes select ranks from the
 * remaining 16, 15, then 14 indices, making distinctness constructive.
 */
export const deriveReleaseRelay = (releaseId: ReleaseId): ReleaseRelayProjection => {
  const adjectiveIndex = symbolIndexFromRemainder(fnv1a32(`${RELEASE_RELAY_ALGORITHM}|adjective|${releaseId}`) % 16)
  const nounIndex = symbolIndexFromRemainder(fnv1a32(`${RELEASE_RELAY_ALGORITHM}|noun|${releaseId}`) % 16)
  const adjective = catalogValueAt(RELEASE_RELAY_V1_ADJECTIVES, adjectiveIndex)
  const noun = catalogValueAt(RELEASE_RELAY_V1_NOUNS, nounIndex)

  return {
    algorithm: RELEASE_RELAY_ALGORITHM,
    codename: `${adjective} ${noun}`,
    symbolIndices: deriveSymbolIndices(releaseId)
  }
}
