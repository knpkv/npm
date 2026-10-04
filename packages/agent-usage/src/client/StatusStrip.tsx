/**
 * What the latest ingest pass found, and anything it could not do. Nothing skipped is hidden.
 *
 * @module
 */
import type { ServerStatus } from "../shared/contracts.js"
import { formatAge } from "./format.js"

type Source = NonNullable<ServerStatus["ingest"]>["claude"]

const describeSource = (name: string, source: Source): string => {
  if (source.rootMissing) return `${name}: no sessions on this machine`
  const skipped = source.skipped.unparseableLine + source.skipped.missingTimestamp + source.skipped.oversizedLine
  const parts = [`${name}: ${source.filesScanned} files`]
  if (skipped > 0) parts.push(`${skipped} lines skipped`)
  if (source.unreadable.length > 0) parts.push(`${source.unreadable.length} unreadable`)
  return parts.join(", ")
}

export const StatusStrip = (props: { readonly status: ServerStatus; readonly now: number }) => {
  const { ingest } = props.status
  const unreadable =
    ingest === null
      ? []
      : [
          ...ingest.claude.unreadable.map((entry) => `claude ${entry.fileKey}: ${entry.reason}`),
          ...ingest.codex.unreadable.map((entry) => `codex ${entry.fileKey}: ${entry.reason}`)
        ]
  return (
    <footer className="usage-status" aria-label="Ingest status">
      <span>{props.status.machine}</span>
      {ingest === null ? (
        <span>first ingest pass running…</span>
      ) : (
        <>
          <span>updated {formatAge(ingest.finishedAt, props.now)}</span>
          <span>{describeSource("Claude", ingest.claude)}</span>
          <span>{describeSource("Codex", ingest.codex)}</span>
        </>
      )}
      {props.status.ingestFailure === null ? null : <span data-tone="failure">{props.status.ingestFailure}</span>}
      {props.status.limitsFailure === null ? null : <span data-tone="failure">{props.status.limitsFailure}</span>}
      {props.status.ticketLookupFailures.map((failure) => (
        <span data-tone="warning" key={failure}>
          {failure}
        </span>
      ))}
      {unreadable.length === 0 ? null : (
        <details>
          <summary>Unreadable paths</summary>
          <ul>
            {unreadable.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      )}
    </footer>
  )
}
