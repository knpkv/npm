/**
 * The answer to "am I about to hit a limit?": each agent's windows, closest first, as a meter, a
 * tone word, when the window resets and how fresh the reading is. Balances sit beneath, quieter.
 *
 * @module
 */
import { FreshnessStamp } from "@knpkv/rly/patterns"
import { LimitTrack, StateLabel, Surface, Text } from "@knpkv/rly/primitives"
import type { BalanceReading, LimitSnapshot } from "../core/Model.js"
import { describeReason, formatAge, formatBalance, formatInstant, formatPercent } from "./format.js"
import { agentName, type LimitTone, NEAR_PERCENT, summarizeLimits, type WindowSummary } from "./limitsModel.js"

interface ToneLabel {
  readonly label: string
  readonly tone: "positive" | "caution" | "critical" | "neutral"
}

const toneLabel = {
  ok: { label: "OK", tone: "positive" },
  near: { label: "Near limit", tone: "caution" },
  "at-limit": { label: "At limit", tone: "critical" },
  unknown: { label: "Unknown", tone: "neutral" }
} satisfies Record<LimitTone, ToneLabel>

const WindowRow = (props: { readonly agent: string; readonly window: WindowSummary; readonly now: number }) => {
  const { window } = props
  const tone = toneLabel[window.tone]
  return (
    <li className="usage-window" data-tone={window.tone}>
      <div className="usage-window-head">
        <Text as="span" variant="label">
          {window.name}
        </Text>
        {/* A healthy window needs no badge; only a state worth acting on gets one. */}
        {window.tone === "ok" ? null : <StateLabel label={tone.label} size="compact" tone={tone.tone} />}
      </div>
      {window.usedPercent === null ? (
        <Text as="p" tone="secondary" variant="meta">
          {window.problem ?? "could not be read"}
        </Text>
      ) : (
        <div className="usage-window-meter">
          {/* Rly's track: the near mark at the same 80% the tone word uses, hatched when the reading is old. */}
          <LimitTrack
            decorative={false}
            label={`${props.agent} ${window.name} used`}
            near={NEAR_PERCENT}
            stale={window.freshness === "stale"}
            value={window.usedPercent}
            valueText={`${formatPercent(window.usedPercent)} used${window.freshness === "stale" ? ", old reading" : ""}`}
          />
          <span className="usage-window-value">{formatPercent(window.usedPercent)}</span>
        </div>
      )}
      <div className="usage-window-meta">
        {window.reset === null || window.resetsAt === null ? null : (
          <Text as="span" tone="secondary" variant="meta">
            <time dateTime={new Date(window.resetsAt).toISOString()} title={formatInstant(window.resetsAt)}>
              {window.reset}
            </time>
          </Text>
        )}
        {window.freshness === "stale" ? (
          <FreshnessStamp
            dateTime={new Date(window.observedAt).toISOString()}
            size="compact"
            state="stale"
            time={`read ${formatAge(window.observedAt, props.now)}`}
          />
        ) : (
          <Text as="span" tone="tertiary" variant="meta">
            <time dateTime={new Date(window.observedAt).toISOString()}>
              read {formatAge(window.observedAt, props.now)}
            </time>
          </Text>
        )}
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
      <Text as="h2" id="limits-now-title" variant="card-title">
        Limits now
      </Text>
      {groups.length === 0 ? (
        <Text as="p" tone="secondary">
          No limit has been read yet.
        </Text>
      ) : (
        <div className="usage-agent-groups">
          {groups.map((group) => (
            <Surface
              as="section"
              aria-label={`${agentName(group.agent)} limits`}
              form="card"
              key={group.agent}
              padding="compact"
            >
              <Text as="h3" variant="label">
                {agentName(group.agent)}
              </Text>
              {group.problem === null ? null : (
                <StateLabel
                  label={`Limits unreadable: ${group.problem.reason}, ${formatAge(group.problem.observedAt, props.now)}`}
                  tone="neutral"
                />
              )}
              <ul className="usage-windows">
                {group.windows.map((window) => (
                  <WindowRow agent={agentName(group.agent)} key={window.id} now={props.now} window={window} />
                ))}
              </ul>
              {group.unnamed.length === 0 ? null : (
                <details className="usage-unnamed">
                  <summary>
                    <Text as="span" tone="secondary" variant="meta">
                      {group.unnamed.length === 1 ? "1 other allowance" : `${group.unnamed.length} other allowances`}
                    </Text>
                  </summary>
                  <ul className="usage-windows">
                    {group.unnamed.map((window) => (
                      <WindowRow agent={agentName(group.agent)} key={window.id} now={props.now} window={window} />
                    ))}
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
              <dt>
                <Text as="span" tone="secondary" variant="meta">
                  {balanceName(balance.kind)}
                </Text>
              </dt>
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
