import { Effect, Option, Schema } from "effect"
import { normalizeAuthor } from "./internal.js"

// AWS returns NumberOfApprovalsNeeded as number or string. A malformed count
// must not discard ApprovalPoolMembers, so the count is coerced separately.
const RuleStatement = Schema.Struct({
  NumberOfApprovalsNeeded: Schema.optional(Schema.Unknown),
  ApprovalPoolMembers: Schema.optional(Schema.Array(Schema.String))
})

const RuleContent = Schema.Struct({
  Statements: Schema.optional(Schema.Array(RuleStatement))
})

const RuleContentFromJson = Schema.fromJsonString(RuleContent)
const decodeRuleContent = Schema.decodeUnknownOption(RuleContentFromJson)

interface ParsedRule {
  readonly requiredApprovals: number
  readonly poolMembers: Array<string>
  readonly poolMemberArns: Array<string>
}

const ruleDefaults: ParsedRule = { requiredApprovals: 1, poolMembers: [], poolMemberArns: [] }

const coerceApprovalCount = (raw: unknown): number => {
  const n = Number(raw ?? 1)
  return Number.isFinite(n) ? n : 1
}

/**
 * Parse AWS approval rule content JSON into pool members + required count.
 * Format: {"Version":"2018-11-08","Statements":[{"Type":"Approvers","NumberOfApprovalsNeeded":N,"ApprovalPoolMembers":["arn:..."]}]}
 *
 * Falls back to defaults on malformed JSON; logs a warning when content was provided.
 */
export const parseRuleContent = (content?: string): Effect.Effect<ParsedRule> =>
  Option.match(decodeRuleContent(content ?? "{}"), {
    onSome: (parsed): Effect.Effect<ParsedRule> => {
      const stmt = parsed.Statements?.[0]
      const rawArns = stmt?.ApprovalPoolMembers ?? []
      return Effect.succeed({
        requiredApprovals: coerceApprovalCount(stmt?.NumberOfApprovalsNeeded),
        poolMembers: rawArns.map(normalizeAuthor),
        poolMemberArns: [...rawArns]
      })
    },
    onNone: () =>
      content
        ? Effect.logWarning("Failed to parse approval rule content", { content }).pipe(Effect.as(ruleDefaults))
        : Effect.succeed(ruleDefaults)
  })
