/** Deterministic OpenAI-compatible response for the bundled PR review. @module */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

import { REVISION_ONE_RETRY_SOURCE } from "./GitFixture.js"

export const CODECOMMIT_MOCK_REVIEW_MODEL = "codecommit-mock-review"

const ChatCompletionInput = Schema.Struct({
  model: Schema.Literal(CODECOMMIT_MOCK_REVIEW_MODEL),
  messages: Schema.Array(Schema.Json)
})

const reviewReport = {
  schemaVersion: 3,
  completion: { status: "complete" },
  orientation: null,
  suggestions: [{
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
  }],
  notes: []
} satisfies Schema.Json

const cleanReviewReport = {
  schemaVersion: 3,
  completion: { status: "complete" },
  orientation: null,
  suggestions: [],
  notes: []
} satisfies Schema.Json

/** Handle one OpenAI chat-completions request without credentials or network access. */
export const reviewModelHandler = (cleanReviewHead?: string) =>
  Effect.gen(function*() {
    const input = yield* HttpServerRequest.schemaBodyJson(ChatCompletionInput)
    const report = cleanReviewHead !== undefined && JSON.stringify(input.messages).includes(cleanReviewHead)
      ? cleanReviewReport
      : reviewReport
    return HttpServerResponse.jsonUnsafe({
      id: "chatcmpl_codecommit_mock_review",
      object: "chat.completion",
      created: 1_787_732_001,
      model: CODECOMMIT_MOCK_REVIEW_MODEL,
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify(report)
        }
      }],
      usage: {
        prompt_tokens: 128,
        completion_tokens: 64,
        total_tokens: 192
      }
    })
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(HttpServerResponse.jsonUnsafe(
        { error: { message: "request does not match the mock review model contract", type: "invalid_request_error" } },
        { status: 400 }
      ))
    )
  )
