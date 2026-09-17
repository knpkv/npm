/**
 * Extract scope from title. Supports:
 * - Conventional commit: feat(scope): message -> scope
 * - Jira-style ticket: ENG-123: message -> ENG-123
 */
export const extractScope = (title: string): string | null => {
  // Conventional commit: feat(scope): message
  const conventional = title.match(/^\w+\(([^)]+)\):/)
  if (conventional?.[1] !== undefined) return conventional[1]

  // Jira-style: ABC-123: message
  const jira = title.match(/^([A-Z]+-\d+):/)
  if (jira?.[1] !== undefined) return jira[1]

  return null
}
