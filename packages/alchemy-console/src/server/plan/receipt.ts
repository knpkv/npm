/** Server-private CI receipt. Full hashes, artifact IDs and hash-only semantic payloads never cross HTTP or logs. */
import { Crypto, Effect, Schema } from "effect"

export const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
export const Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
export const Positive = Schema.Int.check(Schema.isGreaterThan(0))
export const InfraStack = Schema.Literals(["site", "aws-org"])
export type InfraStack = typeof InfraStack.Type
const Key = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/))
const Row = Schema.Struct({
  fqn: Schema.String,
  type: Schema.String,
  action: Schema.Literals(["noop", "update"]),
  changedKeys: Schema.Array(Key).check(Schema.isMaxLength(32)),
  props: Hex,
  attr: Hex,
  bindings: Hex,
  mode: Schema.Literal("live")
})
const common = {
  stack: InfraStack,
  stage: Schema.Literals(["prod", "org"]),
  contentDigest: Hex,
  impact: Schema.Array(InfraStack).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
  rows: Schema.Array(Row).check(Schema.isMaxLength(6)),
  output: Hex
}
const Semantic = Schema.Union([
  Schema.Struct({
    ...common,
    schema: Schema.Literal("alchemy-beta77/ci-native-v1"),
    artifacts: Schema.Struct({ "Site/build": Hex }),
    assetHashes: Schema.Struct({ Site: Hex })
  }),
  Schema.Struct({ ...common, schema: Schema.Literal("alchemy-beta81/ci-native-v1"), artifacts: Schema.Struct({}) })
])
export const Receipt = Schema.Struct({
  schema: Schema.Literal(1),
  stack: InfraStack,
  pr: Positive,
  head: Sha,
  base: Sha,
  toolsSha: Sha,
  toolsDigest: Hex,
  runId: Positive,
  producerRunId: Positive,
  assurance: Schema.Literal("untrusted-native-data/trusted-publication"),
  publisherJobId: Positive,
  rawArtifactId: Positive,
  rawArtifactDigest: Digest,
  native: Schema.Struct({
    schema: Schema.Literal(1),
    stack: InfraStack,
    stage: Schema.Literals(["prod", "org"]),
    digest: Hex,
    hasChanges: Schema.Boolean,
    statePuts: Schema.Literal(0),
    semantic: Semantic
  })
})
export type Receipt = typeof Receipt.Type

export class PlanReceiptInvalid extends Schema.TaggedError<PlanReceiptInvalid>()("PlanReceiptInvalid", {}) {}
export class PlanDigestMismatch extends Schema.TaggedError<PlanDigestMismatch>()("PlanDigestMismatch", {}) {}

const pins = {
  site: new Map([["Site", "Cloudflare.Worker"]]),
  "aws-org": new Map([
    ["Platform", "AWS.Organizations.OrganizationalUnit"],
    ["Sandbox", "AWS.Organizations.OrganizationalUnit"],
    ["Dev1Placement", "Org.AccountPlacement"],
    ["DevPlacement", "Org.AccountPlacement"],
    ["Dev2Placement", "Org.AccountPlacement"],
    ["InfraPlacement", "Org.AccountPlacement"]
  ])
} satisfies Readonly<Record<InfraStack, ReadonlyMap<string, string>>>
export const stageFor = (stack: InfraStack): "prod" | "org" => stack === "site" ? "prod" : "org"

/** SHA-256 of exact bytes. Archive verification and semantic canonicalization supply different byte representations. */
export const hashBytes = Effect.fn("AlchemyConsole.planHash")(function*(bytes: Uint8Array) {
  const cryptoService = yield* Crypto.Crypto
  const hashed = yield* cryptoService.digest("SHA-256", bytes).pipe(Effect.mapError(() => new PlanDigestMismatch({})))
  return Array.from(hashed, (byte) => byte.toString(16).padStart(2, "0")).join("")
})

// Schema.Json proves this recursive traversal contains only JSON data.
const sorted = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(sorted)
  if (Schema.is(Schema.JsonObject)(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key] ?? null)]))
  }
  return value
}
/** Hash native.semantic as recursive sorted-key compact JSON encoded as UTF-8; preserve array order. */
export const semanticHash = (value: Schema.Json) => hashBytes(new TextEncoder().encode(JSON.stringify(sorted(value))))

/** Decode exact keys recursively, enforce the producer's identity pins, then independently recompute its semantic digest. */
export const decodeReceipt = Effect.fn("AlchemyConsole.decodePlanReceipt")(function*(text: string, stack: InfraStack) {
  const receipt = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt))(text, { onExcessProperty: "error" })
    .pipe(
      Effect.mapError(() => new PlanReceiptInvalid({}))
    )
  const native = receipt.native
  const semantic = native.semantic
  const expected = pins[stack]
  if (
    receipt.stack !== stack || native.stack !== stack || semantic.stack !== stack ||
    native.stage !== stageFor(stack) || semantic.stage !== native.stage || receipt.toolsSha !== receipt.base ||
    semantic.schema !== (stack === "site" ? "alchemy-beta77/ci-native-v1" : "alchemy-beta81/ci-native-v1") ||
    semantic.rows.length !== expected.size || new Set(semantic.rows.map((row) => row.fqn)).size !== expected.size ||
    semantic.rows.some((row) => expected.get(row.fqn) !== row.type) ||
    native.hasChanges !== semantic.rows.some((row) => row.action === "update") ||
    !semantic.impact.includes(stack) || new Set(semantic.impact).size !== semantic.impact.length
  ) return yield* new PlanReceiptInvalid({})
  if ((yield* semanticHash(semantic)) !== native.digest) return yield* new PlanDigestMismatch({})
  return receipt
})
