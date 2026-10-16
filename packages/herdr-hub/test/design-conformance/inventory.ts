/** Built-product capability discovery, independent of design reference states. @module */
import { Effect, FileSystem, Path, Schema } from "effect"
import type { Inventory } from "../../../design-conformance/src/schema.js"
import { RunnerFailure } from "../../../design-conformance/src/schema.js"

/** Reachable Hub read presentations. Standalone history loss belongs to its separate owner. */
export const ReviewState = Schema.Literals([
  "review-ready-readonly-legacy",
  "review-p2-expanded-readonly",
  "review-clean-readonly",
  "review-run-unavailable",
  "review-not-recorded-readonly",
  "review-run-unavailable-no-comments",
  "review-run-unavailable-comments-over-limit",
  "review-run-unavailable-comments-corrupt",
  "review-conversation-comments-unavailable",
  "review-threads-conflict",
  "review-conversation-threads-conflict",
  "review-conversation-readonly",
  "review-fix-pushed-readonly",
  "review-dismissed-readonly",
  "review-resolved-readonly",
  "different-revision-findings-head",
  "different-revision-findings-base",
  "different-revision-no-findings",
  "recorded-explain",
  "recorded-extra-fields",
  "deleted-comment",
  "conversation-agent-summary",
  "conversation-finding-discussion",
  "conversation-incomplete",
  "read-pending",
  "read-retained",
  "comments-only-unavailable",
  "review-transport-failed",
  "code-owner-unavailable",
  "diff-reading",
  "diff-unavailable",
  "diff-rejected",
  "placement-refused"
])
export type ReviewState = typeof ReviewState.Type

/** Presentation follows the existing public view selector for every Conversation state. */
export const isConversationState = (state: ReviewState): boolean =>
  state.startsWith("conversation-") || state === "deleted-comment" || state.startsWith("review-conversation-")

export const reviewRoute = (state: ReviewState): string => {
  const query = new URLSearchParams({
    filter: "open",
    search: "",
    offset: "0",
    ref: "00000000-0000-4000-8000-000000000451"
  })
  if (isConversationState(state)) {
    query.set("view", "conversation")
  }
  if (state === "diff-reading" || state === "diff-unavailable" || state === "diff-rejected") query.set("file", "0")
  return `/?${query}#code/pull-requests`
}

export const reviewInventory = (): Inventory => {
  const states = ReviewState.literals.map((state) => ({
    screen: "code-review",
    state,
    route: reviewRoute(state),
    viewports: [390, 1280],
    themes: ["dark"]
  } satisfies Inventory["states"][number]))
  return { routes: Array.from(new Set(states.map(({ route }) => route))), states }
}

/** A legacy checkout has neither contract nor UI. A partial build is never a legacy app. */
export const readReviewCapability = Effect.fn("CodeReviewConformance.readReviewCapability")(
  function*(repository: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const approval = yield* fs.readFileString(path.join(repository, "packages/herdr-hub/dist/approval.js"))
    const contract = yield* fs.readFileString(
      path.join(repository, "packages/codecommit-web/dist/dts/host-contract.d.ts")
    )
    const views = yield* fs.readFileString(path.join(repository, "packages/codecommit-web/dist/views/index.js"))
    const markers = [
      approval.includes("data-code-review-owner"),
      approval.includes("data-code-review-page"),
      /export declare const CodeReviewResult\b/u.test(contract),
      /\bReviewWorkspaceView\b/u.test(views)
    ]
    if (markers.every(Boolean)) return "review"
    if (markers.every((present) => !present)) return "legacy"
    return yield* new RunnerFailure({ detail: "Built Code review UI, view exports and host contract disagree" })
  },
  Effect.mapError((cause) =>
    cause._tag === "RunnerFailure"
      ? cause
      : new RunnerFailure({ detail: `Cannot inspect required Code product build: ${cause.message}` })
  )
)
