/**
 * The plain-text summary `agent-usage ingest` prints after one pass: a line per source, then how
 * long the pass took.
 *
 * @module
 */
import type { IngestStatus, SourceStatus } from "../core/Ingest.js"

const skippedLines = (status: SourceStatus): number =>
  status.skipped.unparseableLine + status.skipped.missingTimestamp + status.skipped.oversizedLine

const describeSource = (name: string, status: SourceStatus): string => {
  if (status.rootMissing) return `${name}: no sessions directory`
  const skipped = skippedLines(status)
  return [
    `${name}: ${status.filesRead}/${status.filesScanned} files read, ${status.eventsAdded} events added`,
    skipped > 0 ? `, ${skipped} lines skipped` : "",
    status.unreadable.length > 0 ? `, ${status.unreadable.length} unreadable` : ""
  ].join("")
}

/** The claude-statusline limit log: absent until claude-statusline has written one. */
const describeLimitLog = (status: SourceStatus): string => {
  if (status.rootMissing) return "claude-statusline limits: none logged yet"
  const skipped = skippedLines(status)
  return [
    "claude-statusline limits: read",
    skipped > 0 ? `, ${skipped} lines skipped` : "",
    status.unreadable.length > 0 ? `, unreadable (${status.unreadable.map((entry) => entry.reason).join(", ")})` : ""
  ].join("")
}

export const describeIngest = (status: IngestStatus): ReadonlyArray<string> => [
  describeSource("claude", status.claude),
  describeSource("codex", status.codex),
  describeLimitLog(status.claudeLimitSamples),
  `took ${status.finishedAt - status.startedAt}ms`
]
