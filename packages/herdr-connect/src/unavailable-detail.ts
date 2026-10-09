/**
 * Every sentence a host's `Unavailable` limits or usage read may carry. hostd chooses one of these
 * and never sends agent-usage's own text, which can name host paths; the hub keeps a peer's detail
 * only when it is one of them, so a peer on an older hostd cannot pass raw stderr on through it.
 *
 * @module
 */
import type { LimitsUnavailableReason } from "./limits.js"

/** What hostd says for each failure it recognises, by agent-usage's own path-free wording. */
export const failureSentences = {
  notRunning: "agent-usage is not running on this host. Start it (or its service).",
  olderVersion: "agent-usage on this host is an older version. Restart it (or its service) on the installed version.",
  storeUnreadable: "agent-usage on this host could not read its store; its log says why.",
  controlSocket: "agent-usage's control socket on this host could not be used; hostd's log says why.",
  unknownTimeZone: "agent-usage on this host does not know the asked time zone.",
  unknownRange: "agent-usage on this host does not offer the asked range.",
  malformed: "agent-usage on this host refused the request as malformed.",
  configuration: "agent-usage on this host could not read its configuration.",
  unexpectedAnswer: "agent-usage on this host answered with something unexpected.",
  spawn: "The agent-usage command on this host could not be started; hostd's log says why.",
  tooLarge: "agent-usage on this host printed more than hostd reads.",
  other: "agent-usage failed on this host; hostd's log has its message."
} satisfies Record<string, string>

/** The one sentence per reason that stands in for anything else a peer sent. */
export const reasonSentences = {
  not_configured: "Not set up on this host.",
  failed: failureSentences.other,
  timeout: "agent-usage on this host did not answer in time.",
  unsupported_version: "agent-usage on this host uses a newer format than this reader knows.",
  invalid_output: "agent-usage on this host printed something this reader could not read."
} satisfies Record<LimitsUnavailableReason, string>

/** Sentences hostd sends besides the failures: why a host is not set up, or did not answer. */
export const notConfiguredSentences = {
  noCommand: "agentUsageLimitsCommand is not set for this host",
  noUsage: "agentUsageLimitsCommand does not end in `limits`, so this host has no `agent-usage usage`"
} satisfies Record<string, string>

const known: ReadonlySet<string> = new Set<string>([
  ...Object.values(failureSentences),
  ...Object.values(reasonSentences),
  ...Object.values(notConfiguredSentences)
])

/** A peer's `Unavailable` detail as the hub passes it on: kept when it is a known sentence, else its reason's. */
export const peerUnavailableDetail = (reason: LimitsUnavailableReason, detail: string): string =>
  known.has(detail) ? detail : reasonSentences[reason]
