/**
 * The answer to "am I about to hit a limit?": each agent's windows, closest first, as a meter, a
 * tone word, when the window resets and how fresh the reading is. Balances sit beneath, quieter.
 *
 * @module
 */
import { FreshnessStamp } from "@knpkv/rly/patterns"
import { StateLabel, Surface, Text } from "@knpkv/rly/primitives"
import type { BalanceReading, LimitSnapshot } from "../core/Model.js"
import { describeReason, formatAge, formatBalance, formatInstant, formatPercent } from "./format.js"
import { agentName, type LimitTone, summarizeLimits, type WindowSummary } from "./limitsModel.js"

const toneLabel: Record<LimitTone, { readonly label: string; readonly tone: "positive" | "caution" | "critical" | "neutral" }> = {
  ok: { label: "OK", tone: "positive" },
  near: { label: "Near limit", tone: "caution" },
  "at-limit": { label: "At limit", tone: "critical" },
  unknown: { label: "Unknown", tone: "neutral" }
}

const WindowRow = (props: { readonly window: WindowSummary; readonly now: number }) => {
  const { window } = props
  const tone = toneLabel[window.tone]
  return (
    <li className="usage-window" data-tone={window.tone}>
      <div className="usage-window-head">
        <Text as="span" variant="label">{window.name}</Text>
        <StateLabel label={tone.label} size="compact" tone={tone.tone} />
      </div>
      {window.usedPercent === null
        ? <Text as="p" tone="secondary" variant="meta">{window.problem ?? "could not be read"}</Text>
        : (
          <div className="usage-window-meter">
            <div
              aria-label={`${window.name} used`}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={Math.min(100, Math.round(window.usedPercent))}
              aria-valuetext={`${formatPercent(window.usedPercent)} used`}
              className="usage-meter"
              role="meter"
            >
              <span className="usage-meter-fill" style={{ inlineSize: `${Math.min(100, window.usedPercent)}%` }} />
            </div>
            <span className="usage-window-value">{formatPercent(window.usedPercent)}</span>
          </div>
        )}
      <div className="usage-window-meta">
        {window.reset === null || window.resetsAt === null
          ? null
          : (
            <Text as="span" tone="secondary" variant="meta">
              <time dateTime={new Date(window.resetsAt).toISOString()} title={formatInstant(window.resetsAt)}>
                {window.reset}
              </time>
            </Text>
          )}
        <FreshnessStamp
          dateTime={new Date(window.observedAt).toISOString()}
          size="compact"
          state={window.freshness}
          time={`read ${formatAge(window.observedAt, props.now)}`}
        />
      </div>
    </li>
  )
}

const balanceName = (kind: BalanceReading["kind"]): string =>
  kind === "claude-extra-usage" ? "Claude extra usage" : "Codex credits"

export const LimitsSummary = (props: {
  readonly latest: ReadonlyArray<LimitSnapshot>
  readonly balances: ReadonlyArray<BalanceReading>
  readonly now: number
}) => {
  const groups = summarizeLimits(props.latest, props.now)
  return (
    <section aria-labelledby="limits-now-title" className="usage-limits-now">
      <Text as="h2" id="limits-now-title" variant="card-title">Limits now</Text>
      {groups.length === 0
        ? <Text as="p" tone="secondary">No limit has been read yet.</Text>
        : (
          <div className="usage-agent-groups">
            {groups.map((group) => (
              <Surface as="section" aria-label={`${agentName(group.agent)} limits`} form="card" key={group.agent} padding="compact">
                <Text as="h3" variant="label">{agentName(group.agent)}</Text>
                {group.problem === null ? null : (
                  <StateLabel
                    label={`Limits unreadable: ${group.problem.reason}, ${formatAge(group.problem.observedAt, props.now)}`}
                    tone="neutral"
                  />
                )}
                <ul className="usage-windows">
                  {group.windows.map((window) => <WindowRow key={window.id} now={props.now} window={window} />)}
                </ul>
                {group.unnamed.length === 0 ? null : (
                  <details className="usage-unnamed">
                    <summary>
                      <Text as="span" tone="secondary" variant="meta">
                        {group.unnamed.length === 1 ? "1 other allowance" : `${group.unnamed.length} other allowances`}
                      </Text>
                    </summary>
                    <ul className="usage-windows">
                      {group.unnamed.map((window) => <WindowRow key={window.id} now={props.now} window={window} />)}
                    </ul>
                  </details>
                )}
              </Surface>
            ))}
          </div>
        )}
      {props.balances.length === 0 ? null : (
        <dl className="usage-balances" aria-label="Balances">
          {props.balances.map((balance) => (
            <div key={`${balance.kind}:${balance.machine}`}>
              <dt><Text as="span" tone="secondary" variant="meta">{balanceName(balance.kind)}</Text></dt>
              <dd>
                <Text as="span" variant="label">
                  {balance.value._tag === "Known" ? formatBalance(balance.value.balance) : "unknown"}
                </Text>{" "}
                <Text as="span" tone="tertiary" variant="meta">
                  {balance.value._tag === "Known" ? "" : `${describeReason(balance.value.reason)} · `}
                  read {formatAge(balance.observedAt, props.now)}
                </Text>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}
