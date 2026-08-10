/** Trusted, prompt-only review playbooks available to Relay. */
export type RelayReviewSkillId = "pr-review" | "pr-review-diff"

export interface RelayReviewSkill {
  readonly description: string
  readonly id: RelayReviewSkillId
  readonly label: string
  readonly prompt: string
}

export const relayReviewSkills: ReadonlyArray<RelayReviewSkill> = [
  {
    id: "pr-review",
    label: "PR Review",
    description: "Broad correctness, security, reliability, tests, and maintainability review.",
    prompt: [
      "Apply the PR Review playbook:",
      "- Review correctness, security, reliability, performance, maintainability, accessibility, architecture, and tests.",
      "- Report only concrete, actionable defects introduced by the supplied patch.",
      "- Assign P1 Critical to broken functionality, security vulnerabilities, or data loss; P2 High to significant bugs, poor UX, or missing validation; P3 Medium to maintainability problems or minor bugs; and P4 Low to style, documentation, or minor improvements.",
      "- Give each issue an exact changed coordinate when the patch supports one.",
      "- Make the summary scannable and the recommendation directly implementable."
    ].join("\n")
  },
  {
    id: "pr-review-diff",
    label: "PR Diff Review",
    description: "High-confidence diff review with explicit scope and verification evidence.",
    prompt: [
      "Apply the PR Diff Review playbook:",
      "- Stay within the supplied diff and distinguish observed evidence from inference.",
      "- Prefer a smaller set of high-confidence findings over speculative concerns.",
      "- Trace security-sensitive trust boundaries and changed behavioral contracts.",
      "- State what verification supports every finding.",
      "- Because host tools are unavailable, never claim that tests, builds, linters, or runtime checks were executed."
    ].join("\n")
  }
]

export const defaultRelayReviewSkills: ReadonlyArray<RelayReviewSkillId> = ["pr-review", "pr-review-diff"]

const relayReviewSkillIds = new Set<RelayReviewSkillId>(relayReviewSkills.map((skill) => skill.id))

/** Deduplicates trusted playbook ids and preserves at least the default review methodology. */
export const normalizeRelayReviewSkills = (
  selected: ReadonlyArray<RelayReviewSkillId>
): ReadonlyArray<RelayReviewSkillId> => {
  const normalized = Array.from(new Set(selected)).filter((id) => relayReviewSkillIds.has(id))
  return normalized.length === 0 ? defaultRelayReviewSkills : normalized
}

/** Renders only host-authored playbook text; repository content never participates in selection. */
export const relayReviewSkillsPrompt = (selected: ReadonlyArray<RelayReviewSkillId>): string => {
  const selectedIds = new Set(normalizeRelayReviewSkills(selected))
  return relayReviewSkills.filter((skill) => selectedIds.has(skill.id)).map((skill) => skill.prompt).join("\n\n")
}

export const relayReviewSkillsLabel = (selected: ReadonlyArray<RelayReviewSkillId>): string => {
  const selectedIds = new Set(normalizeRelayReviewSkills(selected))
  return relayReviewSkills.filter((skill) => selectedIds.has(skill.id)).map((skill) => skill.label).join(" + ")
}
