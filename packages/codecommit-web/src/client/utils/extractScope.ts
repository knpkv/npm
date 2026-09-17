/**
 * Extract scope from title. Supports:
 * - Conventional commit: feat(scope): message -> scope
 * - Jira-style ticket: PROJ-123: message -> PROJ-123
 */
export const extractScope = (title: string): string | null => {
  // Conventional commit: feat(scope): message
  const conventional = title.match(/^\w+\(([^)]+)\):/)
  const scope = conventional?.[1]
  if (scope !== undefined && scope !== "") return scope

  // Jira-style: ABC-123: message
  const jira = title.match(/^([A-Z]+-\d+):/)
  const key = jira?.[1]
  if (key !== undefined && key !== "") return key

  return null
}
