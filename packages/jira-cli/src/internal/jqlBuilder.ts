/**
 * Pre-defined JQL query builders.
 *
 * @module
 */

/**
 * Build JQL query to find issues by fix version.
 *
 * @param version - The fix version to search for
 * @param project - Optional project key to filter by
 * @returns JQL query string
 *
 * @example
 * ```typescript
 * buildByVersionJql("1.0.0")
 * // => 'fixVersion = "1.0.0" ORDER BY key ASC'
 *
 * buildByVersionJql("1.0.0", "PROJ")
 * // => 'project = "PROJ" AND fixVersion = "1.0.0" ORDER BY key ASC'
 * ```
 *
 * @category JQL Builders
 */
export const buildByVersionJql = (version: string, project?: string): string => {
  const escapedVersion = escapeJqlValue(version)
  const projectClause = project !== undefined ? `project = "${escapeJqlValue(project)}" AND ` : ""
  return `${projectClause}fixVersion = "${escapedVersion}" ORDER BY key ASC`
}

/**
 * Escape a value for use in JQL queries.
 *
 * @param value - The value to escape
 * @returns Escaped value safe for JQL
 *
 * @category Utilities
 */
export const escapeJqlValue = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
