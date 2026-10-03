/**
 * The current reading of every Limit Window actually observed, and of each balance. A reading that
 * could not be taken says why; an old one says how old.
 *
 * @module
 */
import type { BalanceReading, LimitSnapshot } from "../core/Model.js"
import { limitLabel } from "./chartModel.js"
import { describeReason, formatAge, formatBalance, formatInstant, formatPercent } from "./format.js"

const balanceName = (kind: BalanceReading["kind"]): string =>
  kind === "claude-extra-usage" ? "Claude extra usage" : "Codex credits"

/**
 * Which snapshots get a tile. A source-wide Unknown reading takes the place of every window read
 * before it, and says why; a window that reset since it was read gets none.
 */
export const tileSnapshots = (latest: ReadonlyArray<LimitSnapshot>, now: number): ReadonlyArray<LimitSnapshot> => {
  const newestFailure = (agent: LimitSnapshot["agent"]) =>
    latest.find((snapshot) => snapshot.agent === agent && snapshot.label === "*")?.observedAt ??
    Number.NEGATIVE_INFINITY
  const newestWindow = (agent: LimitSnapshot["agent"]) =>
    Math.max(
      Number.NEGATIVE_INFINITY,
      ...latest
        .filter((snapshot) => snapshot.agent === agent && snapshot.label !== "*")
        .map((snapshot) => snapshot.observedAt)
    )
  return latest.filter((snapshot) => {
    if (snapshot.label === "*") return snapshot.observedAt > newestWindow(snapshot.agent)
    // A window that has reset since it was last read, or was read before a poll that failed, says
    // nothing about now.
    if (snapshot.reading._tag === "Known" && snapshot.reading.resetsAt !== null && snapshot.reading.resetsAt <= now) {
      return false
    }
    return snapshot.observedAt > newestFailure(snapshot.agent)
  })
}

export const Tiles = (props: {
  readonly latest: ReadonlyArray<LimitSnapshot>
  readonly balances: ReadonlyArray<BalanceReading>
  readonly now: number
}) => (
  <section aria-label="Current limits and balances" className="usage-tiles">
    {tileSnapshots(props.latest, props.now).map((snapshot) => (
      <article
        className="usage-tile"
        data-known={snapshot.reading._tag === "Known"}
        key={`${snapshot.agent}:${snapshot.label}`}
      >
        <h3>{limitLabel(snapshot.agent, snapshot.label, snapshot.windowMinutes)}</h3>
        {snapshot.reading._tag === "Known" ? (
          <>
            <p className="usage-tile-value">{formatPercent(snapshot.reading.usedPercent)}</p>
            <p className="usage-tile-meta">
              {snapshot.reading.resetsAt === null ? "" : `resets ${formatInstant(snapshot.reading.resetsAt)} · `}
              read {formatAge(snapshot.observedAt, props.now)}
            </p>
          </>
        ) : (
          <>
            <p className="usage-tile-value">Unknown</p>
            <p className="usage-tile-meta">
              {describeReason(snapshot.reading.reason)} · {formatAge(snapshot.observedAt, props.now)}
            </p>
          </>
        )}
      </article>
    ))}
    {props.balances.map((balance) => (
      <article
        className="usage-tile"
        data-known={balance.value._tag === "Known"}
        key={`${balance.kind}:${balance.machine}`}
      >
        <h3>{balanceName(balance.kind)}</h3>
        <p className="usage-tile-value">
          {balance.value._tag === "Known" ? formatBalance(balance.value.balance) : "Unknown"}
        </p>
        <p className="usage-tile-meta">
          {balance.value._tag === "Known" ? "" : `${describeReason(balance.value.reason)} · `}
          read {formatAge(balance.observedAt, props.now)}
        </p>
      </article>
    ))}
  </section>
)
