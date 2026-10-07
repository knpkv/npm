/**
 * User-facing hints that more than one module has to say identically.
 *
 * A leaf on purpose: it imports nothing, so the write path can carry a hint without dragging a Jira
 * client behind it. That matters because the same write path now runs in a browser bundle, where an
 * HTTP client and a keychain have no business being.
 *
 * @module
 */

/** The command that connects Jira the recommended way: an API token, no developer console. */
export const CONNECT_JIRA_COMMAND = "jcf auth jira token"

/** What to do when Jira is not connected. The one instruction that fixes every Jira refusal. */
export const NOT_LOGGED_IN_HINT = `Jira is not connected. Run ${CONNECT_JIRA_COMMAND} to connect it.`
