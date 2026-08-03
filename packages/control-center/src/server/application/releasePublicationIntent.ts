import type { ReleasePublicationProvider } from "../../api/agent.js"

export interface ReleasePublicationIntent {
  readonly provider: ReleasePublicationProvider
}

/** Detect only explicit imperative requests for a governed release publication. */
export const detectReleasePublicationIntent = (prompt: string): ReleasePublicationIntent | undefined => {
  const normalized = prompt.trim().toLocaleLowerCase()
  if (
    normalized.length === 0 ||
    /\b(how|can|could|should|what|where|why)\b/u.test(normalized) ||
    /\b(do\s+not|don't|dont|never|not|without|avoid|refuse|cancel|cannot|can't|cant|won't|wont|mustn't|mustnt)\b/u
      .test(normalized) ||
    !/\b(create|publish|post|make)\b/u.test(normalized)
  ) return undefined
  if (
    /\b(confluence)\b/u.test(normalized) &&
    /\b(page|release|artifact)\b/u.test(normalized)
  ) return { provider: "confluence" }
  if (
    /\b(jira)\b/u.test(normalized) &&
    /\b(release|version|artifact)\b/u.test(normalized)
  ) return { provider: "jira" }
  return undefined
}
