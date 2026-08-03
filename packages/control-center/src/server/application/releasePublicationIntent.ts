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
      .test(normalized)
  ) return undefined
  const imperative = /^(?:(?:please|yes|confirmed)\s*[,!:]?\s+|relay\s*[,!:]\s+)*(?:create|publish|post|make)\s+/u
  if (!imperative.test(normalized)) return undefined
  const directObject = normalized.replace(imperative, "")
  const directConfluencePublication =
    /^(?:(?:a|an|the|new)\s+)*confluence\s+(?:release\s+)?(?:page|artifact)(?:\s+for\s+(?:the\s+)?release)?[.!]?$/u
  if (directConfluencePublication.test(directObject)) {
    return { provider: "confluence" }
  }
  const directJiraPublication =
    /^(?:(?:a|an|the|new)\s+)*jira\s+(?:release\s+)?(?:version|artifact)(?:\s+for\s+(?:the\s+)?release)?[.!]?$/u
  if (directJiraPublication.test(directObject)) {
    return { provider: "jira" }
  }
  return undefined
}
