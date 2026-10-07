import { Effect, Schema, SchemaGetter } from "effect"
import { normalizeAuthor } from "./internal.js"

// AWS returns NumberOfApprovalsNeeded as number or string. A malformed count
// must not discard ApprovalPoolMembers, so the count is coerced separately.
// AWS stores ApprovalPoolMembers as written, and a single member can come back as a bare string
// (an "anyone" rule written as ["*"] has been read back as "*"), so both forms are read as a list.
const PoolMembers = Schema.Union([
  Schema.Array(Schema.String),
  Schema.String.pipe(
    Schema.decodeTo(Schema.Array(Schema.String), {
      decode: SchemaGetter.transform((member) => [member]),
      encode: SchemaGetter.transform((members) => members[0] ?? "")
    })
  )
])

const RuleStatement = Schema.Struct({
  NumberOfApprovalsNeeded: Schema.optional(Schema.Unknown),
  ApprovalPoolMembers: Schema.optional(PoolMembers)
})

const RuleContent = Schema.Struct({
  Statements: Schema.optional(Schema.Array(RuleStatement))
})

const RuleContentFromJson = Schema.fromJsonString(RuleContent)
const decodeRuleContent = Schema.decodeUnknownEffect(RuleContentFromJson)

interface ParsedRule {
  readonly requiredApprovals: number
  readonly poolMembers: Array<string>
  readonly poolMemberArns: Array<string>
}

const ruleDefaults: ParsedRule = { requiredApprovals: 1, poolMembers: [], poolMemberArns: [] }

const coerceApprovalCount = <UnparsedInput>(raw: UnparsedInput): number => {
  const n = Number(raw ?? 1)
  return Number.isFinite(n) ? n : 1
}

/**
 * Parse AWS approval rule content JSON into pool members + required count.
 * Format: {"Version":"2018-11-08","Statements":[{"Type":"Approvers","NumberOfApprovalsNeeded":N,"ApprovalPoolMembers":["arn:..."]}]}
 *
 * Falls back to defaults on content it cannot read, and logs the schema error, which names the path
 * that failed, so a rule shown with no pool can be traced.
 */
export const parseRuleContent = (content?: string): Effect.Effect<ParsedRule> =>
  decodeRuleContent(content ?? "{}").pipe(
    Effect.map((parsed): ParsedRule => {
      const stmt = parsed.Statements?.[0]
      const rawArns = [...(stmt?.ApprovalPoolMembers ?? [])]
      return {
        requiredApprovals: coerceApprovalCount(stmt?.NumberOfApprovalsNeeded),
        poolMembers: rawArns.map(normalizeAuthor),
        poolMemberArns: rawArns
      }
    }),
    Effect.catch((error) =>
      content
        ? Effect.logWarning("Failed to parse approval rule content", { error: error.message }).pipe(
          Effect.as(ruleDefaults)
        )
        : Effect.succeed(ruleDefaults)
    )
  )
