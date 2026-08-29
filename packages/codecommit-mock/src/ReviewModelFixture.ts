/** Deterministic OpenAI-compatible response for the bundled PR review. @module */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

import { REVISION_ONE_RETRY_SOURCE } from "./GitFixture.js"

export const CODECOMMIT_MOCK_REVIEW_MODEL = "codecommit-mock-review"

const ChatMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.optionalKey(Schema.Json)
})

const ChatCompletionInput = Schema.Struct({
  model: Schema.Literal(CODECOMMIT_MOCK_REVIEW_MODEL),
  messages: Schema.Array(ChatMessage)
})

const ReviewContextEnvelope = Schema.Struct({
  context: Schema.Struct({
    subject: Schema.Struct({ headRevision: Schema.String })
  })
})

const TextContentPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })

const messageText = (content: Schema.Json | undefined): ReadonlyArray<string> => {
  const text = Schema.decodeUnknownResult(Schema.String)(content)
  if (Result.isSuccess(text)) return [text.success]
  const parts = Schema.decodeUnknownResult(Schema.Array(Schema.Json))(content)
  if (Result.isFailure(parts)) return []
  return parts.success.flatMap((part) => {
    const decoded = Schema.decodeUnknownResult(TextContentPart)(part)
    return Result.isSuccess(decoded) ? [decoded.success.text] : []
  })
}

const reviewHead = (messages: ReadonlyArray<typeof ChatMessage.Type>): string | undefined => {
  for (const message of messages) {
    if (message.role !== "user") continue
    for (const text of messageText(message.content)) {
      const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(ReviewContextEnvelope))(text)
      if (Result.isSuccess(decoded)) return decoded.success.context.subject.headRevision
    }
  }
  return undefined
}

const orientation = {
  summary: "This pull request introduces keyed retry behavior and an executable idempotency contract.",
  cohorts: [
    {
      title: "Make payment retries idempotent",
      summary: "Carry a payment key through the retry boundary, store its in-flight outcome, and prove key reuse.",
      layers: [
        {
          kind: "contract",
          title: "Keyed retry contract",
          summary: "The retry helper now requires a stable payment key.",
          ranges: [{ path: "src/retry.ts", startLine: 1, endLine: 1, label: "Public retry signature" }]
        },
        {
          kind: "data-flow",
          title: "Idempotency identity",
          summary: "The key identifies repeated attempts that must share one outcome.",
          ranges: [{ path: "src/retry.ts", startLine: 1, endLine: 1, label: "Key enters retry boundary" }]
        },
        {
          kind: "implementation",
          title: "Retry execution",
          summary: "The implementation decides whether a repeated attempt invokes the operation again.",
          ranges: [{ path: "src/retry.ts", startLine: 1, endLine: 1, label: "Operation dispatch" }]
        },
        {
          kind: "tests",
          title: "Repeated-key behavior",
          summary: "The executable fixture checks one execution per key and independent execution for another key.",
          ranges: [{ path: "test/retry.test.ts", startLine: 1, endLine: 7, label: "Idempotency contract" }]
        }
      ]
    }
  ]
} satisfies Schema.Json

const reviewReport = {
  schemaVersion: 3,
  completion: { status: "complete" },
  orientation,
  suggestions: [
    {
      title: "Persist the idempotency key before retrying",
      severity: "P1",
      problem: "The retry boundary accepts an idempotency key but never persists it.",
      impact: "A retry can issue the same payment twice after the first attempt loses its response.",
      evidence: {
        path: "src/retry.ts",
        startLine: 1,
        endLine: 1,
        excerpt: REVISION_ONE_RETRY_SOURCE.trim()
      },
      recommendation: "Persist the key before invoking the operation and reuse the stored result on retry.",
      anchor: {
        _tag: "line",
        path: "src/retry.ts",
        line: 1
      },
      relatedLocations: [],
      confidence: {
        level: "high",
        reason: "The added parameter is unused on the exact changed line."
      }
    }
  ],
  notes: []
} satisfies Schema.Json

const cleanReviewReport = {
  schemaVersion: 3,
  completion: { status: "complete" },
  orientation: {
    ...orientation,
    summary: "This revision stores each keyed retry outcome before another attempt can invoke the operation."
  },
  suggestions: [],
  notes: []
} satisfies Schema.Json

/** Handle one OpenAI chat-completions request without credentials or network access. */
export const reviewModelHandler = (cleanReviewHead?: string) =>
  Effect.gen(function*() {
    const input = yield* HttpServerRequest.schemaBodyJson(ChatCompletionInput)
    const report = cleanReviewHead !== undefined && reviewHead(input.messages) === cleanReviewHead
      ? cleanReviewReport
      : reviewReport
    return HttpServerResponse.jsonUnsafe({
      id: "chatcmpl_codecommit_mock_review",
      object: "chat.completion",
      created: 1_787_732_001,
      model: CODECOMMIT_MOCK_REVIEW_MODEL,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify(report)
          }
        }
      ],
      usage: {
        prompt_tokens: 128,
        completion_tokens: 64,
        total_tokens: 192
      }
    })
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          {
            error: { message: "request does not match the mock review model contract", type: "invalid_request_error" }
          },
          { status: 400 }
        )
      )
    )
  )
