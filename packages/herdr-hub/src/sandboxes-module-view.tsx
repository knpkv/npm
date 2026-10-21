/**
 * Sandboxes overview. Lease, extend and release go through `SandboxesModuleWrites`, which submits the
 * existing Fleet job kinds; without it the sheets point to the CLI. Account and runs pages are the next PR.
 * @module
 */
import { leaseCap, leaseDuration, type SandboxCard, type SandboxesOverview } from "@knpkv/sandbox-pool/host"
import { Button, Notice, Sheet, Skeleton, StateLabel, type RlyStateTone } from "@knpkv/rly/primitives"
import { Clock, DateTime, Effect, Exit, Fiber, Result, Schedule, Schema } from "effect"
import { createContext, type ReactElement, type ReactNode, useContext, useEffect, useRef, useState } from "react"
import { ShellIcon } from "./internal/shell-icon.js"
import { moduleHref, type ModulePageMount, type ModuleViews, sandboxesModule } from "./modules.js"
import { SandboxesClientError } from "./sandboxes-client.js"

export { SandboxesClientError }

/** A lease, extend or release job was not submitted. */
export class SandboxesWriteFailed extends Schema.TaggedError<SandboxesWriteFailed>()("SandboxesWriteFailed", {
  reason: Schema.Literals(["rejected", "network", "unauthorized"])
}) {}

/** Owner writes. Each submits the existing Fleet job kind as the caller. */
export interface SandboxesModuleWrites {
  readonly lease: Effect.Effect<void, SandboxesWriteFailed>
  readonly extend: (accountId: SandboxCard["accountId"]) => Effect.Effect<void, SandboxesWriteFailed>
  readonly release: (accountId: SandboxCard["accountId"]) => Effect.Effect<void, SandboxesWriteFailed>
}

/** Overview read. It must keep its identity across renders, or the page reads again on every render. */
export interface SandboxesModuleReads {
  readonly overview: Effect.Effect<SandboxesOverview, SandboxesClientError>
}

type Ready = Extract<SandboxesOverview, { readonly _tag: "Ready" }>
type CardState = SandboxCard["state"]
type RunStep = Extract<CardState, { readonly _tag: "Cleaning" }>["step"] & string

/** What the page paints. `Stale` keeps the last good read after a later one failed. */
type PoolView =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failed" }
  | { readonly _tag: "NotSetUp"; readonly where: "hub" | "host"; readonly host: string | null }
  | { readonly _tag: "Pool"; readonly overview: Ready; readonly readAt: DateTime.Utc; readonly stale: boolean }

const pollEvery = "30 seconds"
const tickEvery = "15 seconds"

const stateRank = { Quarantined: 0, Leased: 1, Cleaning: 2, Available: 3 } satisfies Record<CardState["_tag"], number>

/** A state word and the tone it is drawn in. */
interface Labelled {
  readonly label: string
  readonly tone: RlyStateTone
}

const stateLabel = (tag: CardState["_tag"]): Labelled => {
  switch (tag) {
    case "Available":
      return { label: "Available", tone: "neutral" }
    case "Leased":
      return { label: "Leased", tone: "progress" }
    case "Cleaning":
      return { label: "Cleaning", tone: "progress" }
    case "Quarantined":
      return { label: "Quarantined", tone: "critical" }
  }
}

/** Run order, with the words the card shows for each step. */
const runSteps: ReadonlyArray<{ readonly id: RunStep; readonly name: string }> = [
  { id: "sign in", name: "Signing in" },
  { id: "baseline", name: "Checking baseline" },
  { id: "dry run", name: "Dry run" },
  { id: "nuke", name: "Removing" },
  { id: "verify", name: "Verifying empty" },
  { id: "baseline re-check", name: "Re-checking baseline" },
  { id: "budget hold", name: "Checking budget hold" }
]

const summaryOrder: ReadonlyArray<CardState["_tag"]> = ["Quarantined", "Leased", "Cleaning", "Available"]

const wipeSteps: ReadonlyArray<string> = ["Dry run", "Nuke", "Verify"]

const policyLine =
  "A lease lasts 8 h. Each extend adds 8 h, up to 24 h after the lease started. Ending a lease wipes the account: dry run, nuke, verify."

const millis = DateTime.toEpochMillis

/** "1 h 23 min", "8 h", "0 min". Negative spans read as zero. */
const span = (from: DateTime.Utc, to: DateTime.Utc): string => {
  const total = Math.max(0, Math.round((millis(to) - millis(from)) / 60_000))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  const parts = [hours === 0 ? null : `${hours} h`, minutes === 0 ? null : `${minutes} min`].filter(
    (part) => part !== null
  )
  return parts.length === 0 ? "0 min" : parts.join(" ")
}

/** Clock words in the viewer's time zone. */
interface Times {
  readonly clock: (instant: DateTime.Utc) => string
  /** Clock time today, "tomorrow" on the next day, and the date on any other day. */
  readonly when: (instant: DateTime.Utc, now: DateTime.Utc) => string
  /** Clock time today, "yesterday" on the day before, and the date before that. */
  readonly since: (instant: DateTime.Utc, now: DateTime.Utc) => string
}

/** `timeZone` is an IANA name, such as the browser's own. Days are that zone's calendar days. */
const timesIn = (timeZone: string): Times => {
  const clock = (instant: DateTime.Utc): string =>
    DateTime.format(instant, { hour: "2-digit", hourCycle: "h23", locale: "en-GB", minute: "2-digit", timeZone })
  const date = (instant: DateTime.Utc): string =>
    DateTime.format(instant, { day: "2-digit", locale: "en-CA", month: "2-digit", timeZone, year: "numeric" })
  const dayOf = (instant: DateTime.Utc): number => Math.floor(millis(DateTime.makeUnsafe(date(instant))) / 86_400_000)
  const words = (instant: DateTime.Utc, days: number, next: string): string =>
    days === 0 ? clock(instant) : days === 1 ? `${clock(instant)} ${next}` : `${clock(instant)} on ${date(instant)}`
  return {
    clock,
    when: (instant, now) => words(instant, dayOf(instant) - dayOf(now), "tomorrow"),
    since: (instant, now) => words(instant, dayOf(now) - dayOf(instant), "yesterday")
  }
}

const TimesContext = createContext<Times>(timesIn("UTC"))

const capOf = (startedAt: DateTime.Utc): DateTime.Utc => DateTime.addDuration(startedAt, leaseCap)

/** Add 8h, clamped to 24h after the lease started. The same clamp as `extend`. */
const extendedEnd = (startedAt: DateTime.Utc, endsAt: DateTime.Utc): DateTime.Utc => {
  const extended = DateTime.addDuration(endsAt, leaseDuration)
  return millis(extended) > millis(capOf(startedAt)) ? capOf(startedAt) : extended
}

const atCap = (startedAt: DateTime.Utc, endsAt: DateTime.Utc): boolean =>
  millis(extendedEnd(startedAt, endsAt)) <= millis(endsAt)

/** Each extend adds 8 h, so the lease length in 8 h steps, less the first, is the extend count. */
const extendWords = (startedAt: DateTime.Utc, endsAt: DateTime.Utc): string => {
  const extends_ = Math.max(0, Math.round((millis(endsAt) - millis(startedAt)) / (8 * 3_600_000)) - 1)
  return extends_ === 0
    ? "not extended"
    : extends_ === 1
      ? "extended once"
      : extends_ === 2
        ? "extended twice"
        : `extended ${extends_} times`
}

/** Cards for accounts still in the pool contract. One that left the pool shows, but is no capacity. */
const inPool = (cards: ReadonlyArray<SandboxCard>): ReadonlyArray<SandboxCard> =>
  cards.filter((item) => item.label === null)

/** Same order as `lease`: a null last reset is idle longest, then the oldest reset. */
const longestIdle = (cards: ReadonlyArray<SandboxCard>) =>
  cards
    .flatMap((item) => (item.state._tag === "Available" ? [{ item, lastResetAt: item.state.lastResetAt }] : []))
    .sort((left, right) =>
      left.lastResetAt === null || right.lastResetAt === null
        ? Number(right.lastResetAt === null) - Number(left.lastResetAt === null)
        : millis(left.lastResetAt) - millis(right.lastResetAt)
    )[0]

/** Soonest leased end still ahead. An ended lease waits for the sweep, so it names no time. */
const nextFreeAt = (cards: ReadonlyArray<SandboxCard>, now: DateTime.Utc): DateTime.Utc | undefined =>
  cards
    .flatMap((item) =>
      item.state._tag === "Leased" && millis(item.state.endsAt) > millis(now) ? [item.state.endsAt] : []
    )
    .sort((l, r) => millis(l) - millis(r))[0]

/** Fresh sweep names the clock. A stale badge says late; an older day says yesterday or the date. */
const sweepWords = (times: Times, asOf: number, stale: boolean, now: DateTime.Utc): string => {
  const time = times.since(DateTime.makeUnsafe(asOf), now)
  return stale ? `Sweep late, last ran ${time}` : `Sweep last ${time}.`
}

/** Above the cards when nothing is free: how much is leased, and when the next lease ends. */
const noneFreeWords = (times: Times, all: ReadonlyArray<SandboxCard>, now: DateTime.Utc): string | null => {
  const cards = inPool(all)
  if (cards.length === 0 || cards.some((item) => item.state._tag === "Available")) return null
  const leased = cards.filter((item) => item.state._tag === "Leased").length
  const lead =
    leased < cards.length
      ? "No account is free."
      : cards.length === 1
        ? "The only account is leased."
        : cards.length === 2
          ? "Both accounts are leased."
          : `All ${cards.length} accounts are leased.`
  const freeAt = nextFreeAt(cards, now)
  return freeAt === undefined ? lead : `${lead} The next one frees at ${times.clock(freeAt)}.`
}

const leaseLead = (times: Times, lastResetAt: DateTime.Utc | null, now: DateTime.Utc): string =>
  lastResetAt === null
    ? "Longest idle now: never reset."
    : `Longest idle now: free since ${times.clock(lastResetAt)} (${span(lastResetAt, now)}).`

/** Quarantined, then leased by soonest end, then cleaning, then available. The payload stays in account-id order. */
const byPool = (left: SandboxCard, right: SandboxCard): number => {
  const byState = stateRank[left.state._tag] - stateRank[right.state._tag]
  if (byState !== 0 || left.state._tag !== "Leased" || right.state._tag !== "Leased") return byState
  return millis(left.state.endsAt) - millis(right.state.endsAt)
}

const summary = (cards: ReadonlyArray<SandboxCard>): string =>
  summaryOrder
    .map((tag) => ({ count: cards.filter((item) => item.state._tag === tag).length, word: tag.toLowerCase() }))
    .filter(({ count }) => count > 0)
    .map(({ count, word }) => `${count} ${word}`)
    .join(", ") + "."

/** A later failure keeps a pool on screen as stale; before any pool it is the failed panel. */
const settle = (
  previous: PoolView,
  read: Exit.Exit<SandboxesOverview, SandboxesClientError>,
  at: DateTime.Utc
): PoolView => {
  if (Exit.isSuccess(read) && read.value._tag === "Ready")
    return { _tag: "Pool", overview: read.value, readAt: at, stale: false }
  if (Exit.isSuccess(read) && read.value._tag === "Unavailable" && read.value.reason !== "unavailable") {
    return read.value.reason === "pool_mismatch"
      ? { _tag: "NotSetUp", where: "host", host: read.value.host }
      : { _tag: "NotSetUp", where: "hub", host: read.value.host }
  }
  return previous._tag === "Pool" ? { ...previous, stale: true } : { _tag: "Failed" }
}

/** Reads now and every 30 s while the page is active, and keeps a 15 s clock for the times it shows. */
const usePool = (read: SandboxesModuleReads["overview"], active: boolean) => {
  const [attempt, setAttempt] = useState(0)
  const [view, setView] = useState<PoolView>({ _tag: "Loading" })
  const [now, setNow] = useState(() => DateTime.nowUnsafe())
  useEffect(() => {
    if (!active) return
    const poll = Effect.gen(function* () {
      const result = yield* Effect.exit(read)
      const at = yield* DateTime.now
      yield* Effect.sync(() => {
        setNow(at)
        setView((previous) => settle(previous, result, at))
      })
    }).pipe(Effect.repeat(Schedule.spaced(pollEvery)))
    const tick = Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      yield* Effect.sync(() => setNow(DateTime.makeUnsafe(at)))
    }).pipe(Effect.repeat(Schedule.spaced(tickEvery)), Effect.delay(tickEvery))
    const polling = Effect.runFork(poll)
    const ticking = Effect.runFork(tick)
    return () => {
      Effect.runFork(Fiber.interrupt(polling))
      Effect.runFork(Fiber.interrupt(ticking))
    }
  }, [read, active, attempt])
  return {
    now,
    view,
    /** From the failed panel: show the skeleton again. After a write: keep the cards while it re-reads. */
    readAgain: (blank: boolean) => {
      if (blank) setView({ _tag: "Loading" })
      setAttempt((value) => value + 1)
    }
  }
}

/** Copies the account id. The id stays on screen for a viewer; the lease actions do not. */
const CopyAccountId = ({ accountId }: { readonly accountId: string }): ReactElement => {
  const [failed, setFailed] = useState(false)
  return (
    <>
      <Button
        aria-label={`Copy account ID ${accountId}`}
        onClick={() => {
          const clipboard = navigator.clipboard
          if (clipboard === undefined) {
            setFailed(true)
            return
          }
          void clipboard.writeText(accountId).then(
            () => setFailed(false),
            () => setFailed(true)
          )
        }}
        size="compact"
        variant="quiet"
      >
        Copy
      </Button>
      {failed ? <p role="alert">Couldn’t copy the account ID</p> : null}
    </>
  )
}

type Action = "lease" | "extend" | "release"

const unchangedCopy = {
  lease: "Nothing was leased.",
  extend: "The lease end is unchanged.",
  release: "The lease is unchanged."
} satisfies Record<Action, string>

/** Why a write was refused, then what did not change. A refusal for the owner rule says so. */
const refusedCopy = (action: Action, reason: SandboxesWriteFailed["reason"] | "defect"): string =>
  reason === "unauthorized"
    ? `Only the pool owner can ${action} here. ${unchangedCopy[action]}`
    : reason === "defect"
      ? `The ${action} may not have been submitted. Check the cards before trying again.`
      : `The ${action} wasn’t submitted. ${unchangedCopy[action]}`

const cliCopy = {
  lease: "Lease from the CLI for now.",
  extend: "Extend from the CLI for now.",
  release: "Release from the CLI for now."
} satisfies Record<Action, string>

/**
 * One confirm sheet. `submit` is null until the hub can submit jobs; the footer then points to the CLI.
 * A successful submit closes the sheet and calls `done`; a refusal stays open and says nothing changed.
 */
const ConfirmSheet = ({
  account,
  action,
  children,
  confirm,
  disabled = false,
  done,
  lead,
  submit,
  title,
  trigger,
  triggerVariant
}: {
  readonly account: SandboxCard
  readonly action: Action
  readonly children: ReactNode
  readonly confirm: string
  readonly lead: string
  readonly disabled?: boolean
  readonly done: () => void
  readonly submit: Effect.Effect<void, SandboxesWriteFailed> | null
  readonly title: string
  readonly trigger: string
  readonly triggerVariant: "primary" | "secondary"
}): ReactElement => {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<
    | { readonly _tag: "Idle" }
    | { readonly _tag: "Sending" }
    | { readonly _tag: "Refused"; readonly reason: SandboxesWriteFailed["reason"] | "defect" }
  >({ _tag: "Idle" })
  const opener = useRef<HTMLButtonElement | null>(null)
  const send = (effect: Effect.Effect<void, SandboxesWriteFailed>) => {
    setPhase({ _tag: "Sending" })
    void Effect.runPromiseExit(Effect.result(effect)).then((exit) => {
      if (Exit.isFailure(exit)) {
        setPhase({ _tag: "Refused", reason: "defect" })
      } else if (Result.isFailure(exit.value)) {
        setPhase({ _tag: "Refused", reason: exit.value.failure.reason })
      } else {
        setPhase({ _tag: "Idle" })
        setOpen(false)
        done()
      }
    })
  }
  return (
    <>
      <Button
        className="sandboxes-trigger"
        disabled={disabled}
        onClick={() => {
          // A write still in flight keeps the confirm disabled; only a refusal is cleared on reopen.
          setPhase((current) => (current._tag === "Sending" ? current : { _tag: "Idle" }))
          setOpen(true)
        }}
        ref={opener}
        variant={triggerVariant}
      >
        {trigger}
      </Button>
      <Sheet.Root onOpenChange={setOpen} open={open} restoreFocus={() => opener.current ?? undefined}>
        <Sheet.Content className="sandboxes-sheet" closeLabel="Close panel" title={title}>
          <Sheet.Body className="sandboxes-sheet-body">
            <div className="sandboxes-sheet-account">
              <b>{account.name}</b>
              <code>{account.accountId}</code>
            </div>
            <p className="sandboxes-sheet-lead">{lead}</p>
            {children}
            {phase._tag === "Refused" ? <p role="alert">{refusedCopy(action, phase.reason)}</p> : null}
          </Sheet.Body>
          <Sheet.Footer className="sandboxes-sheet-foot">
            <Button onClick={() => setOpen(false)} variant="quiet">
              Cancel
            </Button>
            {submit === null ? (
              <p className="sandboxes-muted">{cliCopy[action]}</p>
            ) : (
              <Button disabled={phase._tag === "Sending"} onClick={() => send(submit)} variant="primary">
                {confirm}
              </Button>
            )}
          </Sheet.Footer>
        </Sheet.Content>
      </Sheet.Root>
    </>
  )
}

const Facts = ({ rows }: { readonly rows: ReadonlyArray<readonly [string, ReactNode]> }): ReactElement => (
  <dl className="sandboxes-facts">
    {rows.map(([key, value]) => (
      <div key={key}>
        <dt>{key}</dt>
        <dd>{value}</dd>
      </div>
    ))}
  </dl>
)

const Value = ({
  main,
  strong = false,
  sub
}: {
  readonly main: string
  readonly sub?: string
  readonly strong?: boolean
}) => (
  <>
    <span className={strong ? "sandboxes-strong" : undefined}>{main}</span>
    {sub === undefined ? null : <small>{sub}</small>}
  </>
)

/** Card facts per state. Times come from the card; quarantine time and the cleaning reason stay in the store. */
const cardRows = (
  times: Times,
  item: SandboxCard,
  viewer: string,
  now: DateTime.Utc
): ReadonlyArray<readonly [string, ReactNode]> => {
  const state = item.state
  switch (state._tag) {
    case "Leased": {
      const cap = capOf(state.startedAt)
      const capped = atCap(state.startedAt, state.endsAt)
      return [
        ["Holder", <Value main={state.holder === viewer ? `You (${viewer})` : state.holder} />],
        [
          "Time left",
          millis(state.endsAt) <= millis(now) ? (
            <Value main="Ended" strong sub={`Ended ${times.when(state.endsAt, now)}`} />
          ) : (
            <Value main={span(now, state.endsAt)} strong sub={`Ends ${times.when(state.endsAt, now)}`} />
          )
        ],
        [
          "Lease",
          <Value
            main={`Started ${times.clock(state.startedAt)}, ${extendWords(state.startedAt, state.endsAt)}`}
            sub={
              capped
                ? `24 h cap reached, ends ${times.when(state.endsAt, now)}`
                : `${span(state.endsAt, cap)} of the 24 h cap left`
            }
          />
        ]
      ]
    }
    case "Available":
      return [
        ["Holder", <Value main="No one" />],
        ["Idle", <Value main={state.lastResetAt === null ? "Never reset" : span(state.lastResetAt, now)} />],
        ["Last reset", <Value main={state.lastResetAt === null ? "Never" : times.clock(state.lastResetAt)} />]
      ]
    case "Cleaning":
      return [["Holder", <Value main="No one" sub="The account is being cleaned" />]]
    case "Quarantined":
      return [["Holder", <Value main="No one" />]]
  }
}

const stepState = (index: number, current: number): Labelled =>
  current < 0 || index > current
    ? { label: "Waiting", tone: "caution" }
    : index === current
      ? { label: "In progress", tone: "progress" }
      : { label: "Done", tone: "positive" }

const runsHref = (item: SandboxCard): string =>
  moduleHref(sandboxesModule, "runs", new URLSearchParams({ id: item.accountId }))

const CleanupSteps = ({ step }: { readonly step: RunStep | null }): ReactElement => {
  const current = runSteps.findIndex(({ id }) => id === step)
  return (
    <ol aria-label="Cleanup steps" className="sandboxes-steps">
      {runSteps.map(({ id, name }, index) => {
        const { label, tone } = stepState(index, current)
        return (
          <li aria-current={index === current ? "step" : undefined} key={id}>
            <span aria-hidden="true" className="sandboxes-step-number">
              {index + 1}
            </span>
            <span data-step-name="">{name}</span>
            <StateLabel data-step-state="" label={label} size="compact" tone={tone} />
          </li>
        )
      })}
    </ol>
  )
}

const PoolCard = ({
  done,
  item,
  lastKnown,
  now,
  owner,
  viewer,
  writes
}: {
  readonly done: () => void
  readonly item: SandboxCard
  readonly lastKnown: DateTime.Utc | null
  readonly now: DateTime.Utc
  readonly owner: boolean
  readonly viewer: string
  readonly writes: SandboxesModuleWrites | null
}): ReactElement => {
  const times = useContext(TimesContext)
  const { label, tone } = stateLabel(item.state._tag)
  const state = item.state
  const mine = owner && state._tag === "Leased" && state.holder === viewer
  const old = lastKnown === null ? "" : `, last known at ${times.clock(lastKnown)}`
  return (
    <article
      aria-label={`${item.name}, ${label}${old}`}
      className="sandboxes-card"
      data-account={item.name}
      data-mine={mine ? "yes" : "no"}
      data-old={lastKnown === null ? undefined : ""}
    >
      <header>
        <div className="sandboxes-card-name">
          <h2>{item.name}</h2>
          <div className="sandboxes-card-id">
            <code>{item.accountId}</code>
            <CopyAccountId accountId={item.accountId} />
          </div>
          {item.label === null ? null : <small>Left the pool</small>}
          {lastKnown === null ? null : <small>{`Last known at ${times.clock(lastKnown)}`}</small>}
        </div>
        <StateLabel data-pool-state="" {...(tone === "neutral" ? { icon: "minus" } : {})} label={label} tone={tone} />
      </header>
      {state._tag === "Quarantined" ? (
        <div className="sandboxes-card-block">
          <p>{state.blocker.text}</p>
          <a className="sandboxes-link" href={runsHref(item)}>
            View run
          </a>
        </div>
      ) : null}
      <Facts rows={cardRows(times, item, viewer, now)} />
      {state._tag === "Cleaning" ? (
        <div className="sandboxes-card-block">
          <CleanupSteps step={state.step} />
          <div className="sandboxes-card-line">
            <small>{`Run ${state.runId}`}</small>
            <a className="sandboxes-link" href={runsHref(item)}>
              View run
            </a>
          </div>
        </div>
      ) : null}
      {mine && state._tag === "Leased" ? (
        <OwnLease done={done} item={item} now={now} state={state} writes={writes} />
      ) : null}
    </article>
  )
}

/** Extend and Release for the lease this viewer holds. Extend stays visible at the cap, disabled, with the reason. */
const OwnLease = ({
  done,
  item,
  now,
  state,
  writes
}: {
  readonly done: () => void
  readonly item: SandboxCard
  readonly now: DateTime.Utc
  readonly state: Extract<CardState, { readonly _tag: "Leased" }>
  readonly writes: SandboxesModuleWrites | null
}): ReactElement => {
  const times = useContext(TimesContext)
  const next = extendedEnd(state.startedAt, state.endsAt)
  const cap = capOf(state.startedAt)
  const capped = atCap(state.startedAt, state.endsAt)
  return (
    <div className="sandboxes-card-actions">
      <div className="sandboxes-card-buttons">
        <ConfirmSheet
          action="extend"
          confirm={`Extend to ${times.clock(next)}`}
          account={item}
          lead="Adds 8 h to your lease."
          disabled={capped}
          done={done}
          submit={writes === null ? null : Effect.suspend(() => writes.extend(item.accountId))}
          title="Extend lease"
          trigger="Extend"
          triggerVariant="secondary"
        >
          <Facts
            rows={[
              ["Ends now", times.when(state.endsAt, now)],
              ["New end", <span className="sandboxes-strong">{times.when(next, now)}</span>],
              ["Cap left after", `${span(next, cap)}, cap at ${times.when(cap, now)}`]
            ]}
          />
          <small className="sandboxes-muted">A lease can run up to 24 h after it started.</small>
        </ConfirmSheet>
        <ConfirmSheet
          action="release"
          confirm="Release and wipe"
          account={item}
          lead="Releasing ends your lease now and wipes the account."
          done={done}
          submit={writes === null ? null : Effect.suspend(() => writes.release(item.accountId))}
          title="Release lease"
          trigger="Release"
          triggerVariant="secondary"
        >
          <ol className="sandboxes-wipe">
            {wipeSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <Notice tone="caution">{`Everything in ${item.name} is deleted. This can’t be undone.`}</Notice>
        </ConfirmSheet>
      </div>
      {capped ? (
        <small className="sandboxes-muted">{`Extend: 24-hour cap reached at ${times.when(cap, now)}.`}</small>
      ) : null}
    </div>
  )
}

const LeaseAction = ({
  done,
  now,
  overview,
  writes
}: {
  readonly done: () => void
  readonly now: DateTime.Utc
  readonly overview: Ready
  readonly writes: SandboxesModuleWrites | null
}): ReactElement => {
  const times = useContext(TimesContext)
  const chosen = longestIdle(inPool(overview.sandboxes))
  const freeAt = nextFreeAt(inPool(overview.sandboxes), now)
  if (chosen === undefined) {
    return (
      <div className="sandboxes-lease">
        <Button className="sandboxes-trigger" disabled variant="primary">
          Lease an account
        </Button>
        <small className="sandboxes-muted">
          {freeAt === undefined ? "No account is free." : `No account is free until ${times.clock(freeAt)}.`}
        </small>
      </div>
    )
  }
  const ends = DateTime.addDuration(now, leaseDuration)
  return (
    <div className="sandboxes-lease">
      <ConfirmSheet
        action="lease"
        confirm="Lease longest idle"
        account={chosen.item}
        lead={leaseLead(times, chosen.lastResetAt, now)}
        done={done}
        submit={writes === null ? null : writes.lease}
        title="Lease an account"
        trigger="Lease an account"
        triggerVariant="primary"
      >
        <Facts
          rows={[
            ["Starts", `Now, ${times.clock(now)}`],
            ["Ends", <span className="sandboxes-strong">{times.clock(ends)}</span>],
            ["Extend up to", times.when(capOf(now), now)]
          ]}
        />
        <small className="sandboxes-muted">
          Fleet leases whichever account is longest idle when the job runs. When the lease ends the account is cleaned:
          dry run, nuke, verify.
        </small>
      </ConfirmSheet>
    </div>
  )
}

const notSetUpCopy = (where: "hub" | "host", host: string | null) =>
  where === "hub"
    ? { label: "Not set up", title: "Sandboxes aren’t set up on this hub." }
    : {
        label: "Not configured",
        title: host === null ? "The pool isn’t configured on its host." : `The pool isn’t configured on ${host}.`
      }

const staleWords = (readAt: DateTime.Utc, now: DateTime.Utc): string =>
  `Stale, updated ${Math.max(1, Math.floor((millis(now) - millis(readAt)) / 60_000))}m ago`

const OverviewPage = ({
  mount,
  owner,
  reads,
  viewer,
  writes
}: {
  readonly mount: ModulePageMount
  readonly owner: boolean
  readonly reads: SandboxesModuleReads
  readonly viewer: string
  readonly writes: SandboxesModuleWrites | null
}): ReactElement => {
  const times = useContext(TimesContext)
  const { now, readAgain, view } = usePool(reads.overview, mount.active)
  const pool = view._tag === "Pool" ? view : null
  // A job runs after it is submitted, so the next read can still show the old card; say so for a minute.
  const [submittedAt, setSubmittedAt] = useState<DateTime.Utc | null>(null)
  const submitted = submittedAt !== null && millis(now) - millis(submittedAt) < 60_000
  const reread = () => {
    setSubmittedAt(DateTime.nowUnsafe())
    readAgain(false)
  }
  const count = pool?.overview.sandboxes.length
  const noneFree = pool === null ? null : noneFreeWords(times, pool.overview.sandboxes, pool.stale ? pool.readAt : now)
  return (
    <section className="sandboxes-page">
      <header className="sandboxes-head">
        <div className="sandboxes-title">
          <h1>Sandboxes</h1>
          {count === undefined ? null : <p>{count === 1 ? "1 account" : `${count} accounts`}</p>}
          <div aria-live="polite" role="status">
            {pool !== null && pool.stale ? (
              <StateLabel icon="clock" label={staleWords(pool.readAt, now)} tone="caution" />
            ) : null}
          </div>
        </div>
        {owner && pool !== null ? (
          <LeaseAction done={reread} now={now} overview={pool.overview} writes={pool.stale ? null : writes} />
        ) : null}
      </header>
      {submitted ? (
        <p className="sandboxes-muted" data-pool-submitted="" role="status">
          Submitted to Fleet. The cards update when the job runs.
        </p>
      ) : null}
      {!owner && pool !== null ? (
        <p className="sandboxes-muted">
          Only the owner can lease or reset sandboxes here. Agents lease through Fleet jobs.
        </p>
      ) : null}
      {view._tag === "Loading" ? (
        <div className="sandboxes-grid">
          <p className="sandboxes-hidden" role="status">
            Reading the pool
          </p>
          <Skeleton className="sandboxes-skeleton" data-skeleton="" />
          <Skeleton className="sandboxes-skeleton" data-skeleton="" />
        </div>
      ) : view._tag === "Failed" ? (
        <section className="sandboxes-panel">
          <StateLabel label="Can’t read" tone="critical" />
          <h2>Can’t read the pool from hostd</h2>
          <p>Accounts and leases aren’t shown until the lease store answers. Nothing was changed.</p>
          <Button onClick={() => readAgain(true)} variant="primary">
            Read again
          </Button>
        </section>
      ) : view._tag === "NotSetUp" ? (
        <section className="sandboxes-panel">
          <StateLabel icon="minus" label={notSetUpCopy(view.where, view.host).label} tone="neutral" />
          <h2>{notSetUpCopy(view.where, view.host).title}</h2>
        </section>
      ) : (
        <div className="sandboxes-pool">
          <div className="sandboxes-meta">
            <div className="sandboxes-meta-line">
              <span data-pool-summary="">{summary(view.overview.sandboxes)}</span>
              <span data-pool-read="">{`Read ${times.clock(view.readAt)} from hostd`}</span>
            </div>
            {view.overview.badge.asOf === null ? (
              <StateLabel icon="clock" label="Sweep has not run yet" size="compact" tone="caution" />
            ) : view.overview.badge.stale ? (
              <StateLabel
                icon="clock"
                label={sweepWords(times, view.overview.badge.asOf, true, now)}
                size="compact"
                tone="caution"
              />
            ) : (
              <span>{sweepWords(times, view.overview.badge.asOf, false, now)}</span>
            )}
          </div>
          {noneFree === null ? null : (
            <Notice data-pool-notice="" tone="neutral">
              {noneFree}
            </Notice>
          )}
          <div className="sandboxes-grid">
            {[...view.overview.sandboxes].sort(byPool).map((item) => (
              <PoolCard
                done={reread}
                item={item}
                key={item.accountId}
                lastKnown={view.stale ? view.readAt : null}
                now={view.stale ? view.readAt : now}
                owner={owner}
                viewer={viewer}
                writes={view.stale ? null : writes}
              />
            ))}
          </div>
          <p className="sandboxes-muted sandboxes-policy">{policyLine}</p>
        </div>
      )}
    </section>
  )
}

/** `View run` lands here until the runs page ships; a blank module would read as broken. */
const NotYetPage = (): ReactElement => (
  <section className="sandboxes-page">
    <header className="sandboxes-head">
      <div className="sandboxes-title">
        <h1>Sandboxes</h1>
      </div>
    </header>
    <section className="sandboxes-panel">
      <h2>Run details aren’t on the hub yet.</h2>
      <p>Each account’s cleanup runs come in a later version. The pool shows each account’s current step.</p>
      <a className="sandboxes-link" href={moduleHref(sandboxesModule, "overview")}>
        Back to the pool
      </a>
    </section>
  </section>
)

/**
 * Overview for the shell. `owner` is the hub's own node; `viewer` is that caller's login, matched against a
 * lease holder. `writes` is null until the hub can submit sandbox jobs from the browser.
 */
export const makeSandboxesModuleViews = ({
  owner,
  reads,
  timeZone,
  viewer,
  writes
}: {
  readonly owner: boolean
  readonly reads: SandboxesModuleReads
  /** The viewer's IANA time zone; every clock time and day on the page is in it. */
  readonly timeZone: string
  readonly writes: SandboxesModuleWrites | null
  readonly viewer: string
}): ModuleViews<typeof sandboxesModule> => {
  const times = timesIn(timeZone)
  return {
    descriptor: sandboxesModule,
    navigationIcon: <ShellIcon name="sandboxes" />,
    pages: {
      overview: (_search, mount) => (
        <TimesContext value={times}>
          <OverviewPage mount={mount} owner={owner} reads={reads} viewer={viewer} writes={writes} />
        </TimesContext>
      ),
      account: () => null,
      runs: () => <NotYetPage />
    }
  }
}
