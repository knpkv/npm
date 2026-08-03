/** Least-privilege OAuth scopes for Control Center's Jira capability. @module */

/**
 * Jira read, identity, refresh, and project-version publication scopes.
 *
 * `manage:jira-project` authorizes create-only project-version publication.
 * Issue mutations remain proposal-only, so `write:jira-work` is excluded.
 */
export const CONTROL_CENTER_JIRA_OAUTH_SCOPES: ReadonlyArray<string> = [
  "read:jira-work",
  "manage:jira-project",
  "read:jira-user",
  "read:me",
  "offline_access"
]
