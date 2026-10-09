/**
 * Claude and Codex limits in Connect: one line of state labels ("Claude 48% weekly", "Codex
 * unknown") under the summary, linking to the hub's Usage tab, where each host's cards and history
 * live. Renders a {@link ConnectLimitsView}; reads no clock.
 *
 * @module
 */
import type { LimitTone } from "@knpkv/agent-usage/limits"
import { type RlyStateTone, StateLabel, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import type { ConnectLimitsView } from "./limits-model.js"

const stateTone = {
  ok: "positive",
  near: "caution",
  "at-limit": "critical",
  unknown: "neutral"
} satisfies Record<LimitTone, RlyStateTone>

/** The hub's Usage tab; the hub serves Connect's standalone page too, so the link works from both. */
export const USAGE_TAB_HREF = "/?tab=usage"

/**
 * The limits line and its link to the Usage tab. With no view yet it shows nothing (or why the load
 * failed); with limits off on every host it shows nothing at all.
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
      <a className="connect-limits-link" href={USAGE_TAB_HREF}>
        {view.hosts.length > 1 ? "Limits and usage on each host" : "Limits and usage"}
      </a>
    </div>
  )
}
