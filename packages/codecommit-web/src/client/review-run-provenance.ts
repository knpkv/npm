/** Recorded execution provenance only. A profile is not an agent identity. @module */
import type { ReviewKind, ReviewRun } from "@knpkv/review"

const kindWords = {
  review: "Code review",
  security: "Security review",
  tests: "Test review",
  explain: "Change explanation"
} satisfies Record<ReviewKind, string>

const harnessLabel = (harness: string): string =>
  harness === "native-claude" ?
    "Claude Code"
    : harness === "native-codex"
    ? "Codex"
    : harness

/** Preserve unknown recorded harness identifiers without inventing an agent or avatar. */
export const reviewRunProvenance = (run: ReviewRun): string =>
  run.profile === null ?
    kindWords[run.kind]
    : `${run.profile.name}, ${harnessLabel(run.profile.harness)}, ${run.profile.model}, ${kindWords[run.kind]}`
