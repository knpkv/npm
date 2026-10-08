/**
 * Claude and Codex limits in Connect: one line of state labels ("Claude 48% weekly", "Codex
 * unknown") under the summary, and agent-usage's own cards for each host behind a disclosure, so
 * the agent list stays first on a phone. Renders a {@link ConnectLimitsView}; reads no clock.
 *
 * @module
 */
import { LimitsSummary, type LimitTone } from "@knpkv/agent-usage/limits"
import { type RlyStateTone, StateLabel, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import type { ConnectLimitsView } from "./limits-model.js"

const stateTone = {
  ok: "positive",
  near: "caution",
  "at-limit": "critical",
  unknown: "neutral"
} satisfies Record<LimitTone, RlyStateTone>

/**
 * The limits line and its disclosure. With no view yet it shows nothing (or why the load failed);
 * with limits off on every host it shows nothing at all.
 */
export const ConnectLimits = ({
  problem,
  view
}: {
  readonly problem: string | null
  readonly view: ConnectLimitsView | null
}): ReactElement | null => {
  if (view === null) {
    return problem === null ? null : (
      <Text as="p" className="connect-limits-problem" tone="secondary" variant="meta">
        {problem}
      </Text>
    )
  }
  if (view.off) return null
  const severalHosts = view.hosts.length > 1
  return (
    <div className="connect-limits">
      {view.line.length === 0 ? null : (
        <ul aria-label="Usage limits" className="connect-limits-line">
          {view.line.map((item) => (
            <li key={item.agent}>
              <StateLabel label={item.text} size="compact" tone={stateTone[item.tone]} />
            </li>
          ))}
        </ul>
      )}
      <details className="connect-limits-details">
        <summary>{severalHosts ? "Limits on each host" : "Limit details"}</summary>
        {/* A <details> lays its content out through an internal slot, so the grid is a wrapper's. */}
        <div className="connect-limits-hosts">
        {problem === null ? null : (
          <Text as="p" tone="secondary" variant="meta">
            {problem}
          </Text>
        )}
        {view.hosts.map((host) => (
          <LimitsSummary
            balances={[]}
            key={host.host}
            latest={host.latest}
            now={host.now}
            title={severalHosts ? `Limits on ${host.host}` : "Limits now"}
          />
        ))}
        {view.notes.length === 0 ? null : (
          <ul className="connect-limits-notes">
            {view.notes.map((note) => (
              <li key={note}>
                <Text as="span" tone="secondary" variant="meta">
                  {note}
                </Text>
              </li>
            ))}
          </ul>
        )}
        </div>
      </details>
    </div>
  )
}
