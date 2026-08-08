/** Read-only local agent reviews for exact CodeCommit PR revisions. */
import { streamEvents } from "@knpkv/ai-codex"
import { Effect, Option, Schema, Stream } from "effect"

export type RelayReviewKind = "explain" | "review" | "security" | "tests"

export interface RelayReviewRequest {
  readonly baseCommit: string
  readonly headCommit: string
  readonly kind: RelayReviewKind
  readonly pullRequestId: string
  readonly repositoryName: string
  readonly title: string
  readonly worktreePath: string
}

const AgentMessageEvent = Schema.fromJsonString(Schema.Struct({
  type: Schema.Literal("item.completed"),
  item: Schema.Struct({
    type: Schema.Literal("agent_message"),
    text: Schema.String
  })
}))

const decodeAgentMessage = Schema.decodeUnknownOption(AgentMessageEvent)

const focusByKind: Record<RelayReviewKind, string> = {
  review: "Find correctness, security, reliability, and maintainability defects. Prioritize actionable findings.",
  security: "Perform a security-focused review. Trace trust boundaries, authorization, secrets, and unsafe inputs.",
  tests: "Review the test strategy. Find missing behavioral guardrails and weak or misleading coverage.",
  explain: "Explain the change, its architecture, and the highest merge risks for a human reviewer."
}

export const makeRelayReviewPrompt = (request: RelayReviewRequest): string =>
  [
    `Review CodeCommit PR #${request.pullRequestId}: ${request.title}`,
    `Repository: ${request.repositoryName}`,
    `Immutable base: ${request.baseCommit}`,
    `Immutable head: ${request.headCommit}`,
    "Inspect the checkout and compare the exact commits with git diff.",
    focusByKind[request.kind],
    "Do not modify files. Return concise findings with file and line references, then a short verdict."
  ].join("\n")

/** Runs an ephemeral, read-only Codex review and returns its final agent message. */
export const runRelayReview = (request: RelayReviewRequest) =>
  Stream.runLast(
    streamEvents({
      access: "read-only",
      cwd: request.worktreePath,
      prompt: makeRelayReviewPrompt(request),
      timeout: "5 minutes"
    }).pipe(
      Stream.map((line) => decodeAgentMessage(line)),
      Stream.filter(Option.isSome),
      Stream.map((decoded) => decoded.value.item.text)
    )
  ).pipe(
    Effect.map(Option.getOrElse(() => "Relay completed without a final summary."))
  )
