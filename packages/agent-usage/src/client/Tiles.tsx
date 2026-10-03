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
 * Which snapshots get a tile: none whose window reset since it was read. A source-wide Unknown reading only gets one while it is newer than
 * every window read from that agent: then the windows' values are stale, and the tile says why.
 */
export const tileSnapshots = (latest: ReadonlyArray<LimitSnapshot>, now: number): ReadonlyArray<LimitSnapshot> =>
  latest.filter(
    (snapshot) =>
      // A window that has reset since it was last read says nothing about now.
      !(snapshot.reading._tag === "Known" && snapshot.reading.resetsAt !== null && snapshot.reading.resetsAt <= now) &&
      (snapshot.label !== "*" ||
        latest.every(
          (other) => other.agent !== snapshot.agent || other.label === "*" || other.observedAt < snapshot.observedAt
        ))
  )

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
