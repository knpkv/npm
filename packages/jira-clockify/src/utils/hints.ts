/**
 * User-facing hints that more than one module has to say identically.
 *
 * A leaf on purpose: it imports nothing, so the write path can carry a hint without dragging a Jira
 * client behind it. That matters because the same write path now runs in a browser bundle, where an
 * HTTP client and a keychain have no business being.
 *
 * @module
 */

/** What to do about an expired Jira session. The one instruction that fixes every Jira refusal. */
export const NOT_LOGGED_IN_HINT = "Not logged in to Jira. Run: jcf auth jira login"
