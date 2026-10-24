/**
 * Sandboxes overview, one account's page and its runs. Lease, extend and release go through
 * `SandboxesModuleWrites`, which submits the existing Fleet job kinds; without it the sheets point to the CLI.
 * Resets and budget lifts are Fleet approvals: these pages show a pending one and link Fleet / Approvals.
 * @module
 */
import {
  cliProfile,
  consoleUrl,
  leaseCap,
  leaseDuration,
  SandboxCard,
  type SandboxesOverview,
  type SandboxRunLog,
  type SandboxRuns,
  type SandboxRunView,
  type SandboxSignIn,
  type SandboxSpend
} from "@knpkv/sandbox-pool/host"
import { Icon } from "@knpkv/rly/foundations"
import { Button, Notice, Sheet, Skeleton, StateLabel, type RlyStateTone } from "@knpkv/rly/primitives"
import { Clock, DateTime, Effect, Exit, Fiber, Result, Schedule, Schema } from "effect"
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react"
import { ShellIcon } from "./internal/shell-icon.js"
import { StateCard } from "./internal/state-card.js"
import { fleetHubModule, moduleHref, type ModulePageMount, type ModuleViews, sandboxesModule } from "./modules.js"
import { SandboxesClientError, SandboxesSignOutFailed, SandboxesWriteFailed } from "./sandboxes-client.js"
import type { SandboxAwsSession, SandboxesCaller, SandboxRequest, SandboxRequests } from "./sandboxes-contract.js"

export { SandboxesClientError, SandboxesSignOutFailed, SandboxesWriteFailed }

/** Owner writes. Each submits the existing Fleet job kind as the caller. */
export interface SandboxesModuleWrites {
  readonly lease: Effect.Effect<void, SandboxesWriteFailed>
  readonly extend: (accountId: SandboxCard["accountId"]) => Effect.Effect<void, SandboxesWriteFailed>
  readonly release: (accountId: SandboxCard["accountId"]) => Effect.Effect<void, SandboxesWriteFailed>
  /** Asks Fleet to retry a quarantine's reset. It waits for an approval in Fleet / Approvals. */
  readonly retry: (accountId: SandboxCard["accountId"]) => Effect.Effect<void, SandboxesWriteFailed>
  /** Asks Fleet to lift a budget stop. It waits for an approval in Fleet / Approvals. */
  readonly liftBudget: (accountId: SandboxCard["accountId"]) => Effect.Effect<void, SandboxesWriteFailed>
  /** Starts the hub's AWS sign-in, or joins the one waiting, and answers what to approve. */
  readonly startAwsSignIn: Effect.Effect<SandboxAwsSession, SandboxesWriteFailed>
  /** Signs the hub out of AWS, on AWS's side too, and answers the sign-in it now holds. */
  readonly signOutAws: Effect.Effect<SandboxAwsSession, SandboxesSignOutFailed>
}

/** Page reads. Each must keep its identity across renders, or the page reads again on every render. */
export interface SandboxesModuleReads {
  readonly overview: Effect.Effect<SandboxesOverview, SandboxesClientError>
  /** Who is reading. Until it answers, or if it fails, the page shows no owner actions. */
  readonly caller: Effect.Effect<SandboxesCaller, SandboxesClientError>
  /** The newest page of one account's runs. */
  readonly runs: (accountId: SandboxCard["accountId"]) => Effect.Effect<SandboxRuns, SandboxesClientError>
  /** One run's log tail and stored failure line. The hub answers only the owner; read only for the owner. */
  readonly runLog: (
    accountId: SandboxCard["accountId"],
    runId: SandboxRunView["runId"]
  ) => Effect.Effect<SandboxRunLog, SandboxesClientError>
  /** Resets and budget lifts waiting in Fleet / Approvals. */
  readonly requests: Effect.Effect<SandboxRequests, SandboxesClientError>
  /** The hub's AWS sign-in. The hub answers the owner only; read only for the owner. */
  readonly awsSession: Effect.Effect<SandboxAwsSession, SandboxesClientError>
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
/** While a sign-in waits for its approval, for at most 10 minutes. */
const pendingPollEvery = "5 seconds"
const pendingPollFor = 600_000
const tickEvery = "15 seconds"

/** A quarantine whose blocker is a budget hold: stopped by budget, in caution, after every other quarantine. */
const budgetStopped = (state: CardState): boolean => state._tag === "Quarantined" && state.blocker._tag === "BudgetHold"

type PoolRank = CardState["_tag"] | "BudgetStopped"

const rankOf = (state: CardState): PoolRank => (budgetStopped(state) ? "BudgetStopped" : state._tag)

const stateRank = {
  Quarantined: 0,
  BudgetStopped: 1,
  Leased: 2,
  Cleaning: 3,
  Available: 4
} satisfies Record<PoolRank, number>

/** A state word and the tone it is drawn in. */
interface Labelled {
  readonly label: string
  readonly tone: RlyStateTone
}

const stateLabel = (tag: PoolRank): Labelled => {
  switch (tag) {
    case "BudgetStopped":
      return { label: "Stopped by budget", tone: "caution" }
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

const summaryOrder: ReadonlyArray<readonly [PoolRank, string]> = [
  ["Quarantined", "quarantined"],
  ["BudgetStopped", "stopped by budget"],
  ["Leased", "leased"],
  ["Cleaning", "cleaning"],
  ["Available", "available"]
]

/** The budget-hold words the design gives a stopped account. The stored hold line is never shown. */
const budgetHoldWords =
  "Budget hold: this account passed its monthly spend cap, so it’s locked until an approver lifts the hold. Cleanup still ran."

/** Who a Fleet request waits on. No route names the approver, so this stays generic until one does. */
const waitsOn = "an approver"

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
  /** Clock time with seconds, for log lines. */
  readonly seconds: (instant: DateTime.Utc) => string
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
    seconds: (instant) =>
      DateTime.format(instant, {
        hour: "2-digit",
        hourCycle: "h23",
        locale: "en-GB",
        minute: "2-digit",
        second: "2-digit",
        timeZone
      }),
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

/** Quarantined, then stopped by budget, then leased by soonest end, then cleaning, then available. The payload stays in account-id order. */
const byPool = (left: SandboxCard, right: SandboxCard): number => {
  const byState = stateRank[rankOf(left.state)] - stateRank[rankOf(right.state)]
  if (byState !== 0 || left.state._tag !== "Leased" || right.state._tag !== "Leased") return byState
  return millis(left.state.endsAt) - millis(right.state.endsAt)
}

const summary = (cards: ReadonlyArray<SandboxCard>): string =>
  summaryOrder
    .map(([rank, word]) => ({ count: cards.filter((item) => rankOf(item.state) === rank).length, word }))
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

const observeModeCopy = "The pool is in observe mode: it reads spend and runs no jobs."
const awsFirstCopy = "Sign in to AWS first: Release, Retry reset and Request to lift the stop need it."
const observeLineId = "sandboxes-observe-mode"
const awsFirstId = "sandboxes-aws-first"

/** The jobs the page offers. Release, retry and lift run AWS calls; lease and extend change only the store. */
type GatedAction = Action | RequestKind
const needsAws: ReadonlySet<GatedAction> = new Set<GatedAction>(["release", "retry", "lift"])

/** What the hub's mode and AWS sign-in hold back on this page, and whether spend readings are last known. */
interface AwsView {
  /** The id of the line saying why `action` is held back, or null when it isn’t. */
  readonly heldBy: (action: GatedAction) => string | null
  readonly spendOld: boolean
}

const AwsContext = createContext<AwsView>({ heldBy: () => null, spendOld: false })

/**
 * Observe mode holds back every job; a live pool the hub isn’t signed in to holds back the jobs that call AWS.
 * The owner knows the sign-in from aws-session; anyone else only whether the hub is signed in.
 */
const awsViewOf = (caller: SandboxesCaller, session: SandboxAwsSession | null): AwsView => {
  const signedOut = caller.owner
    ? session !== null && (session._tag === "SignInRequired" || session._tag === "SignInPending")
    : caller.awsSignedIn === false
  return {
    heldBy: (action) =>
      caller.poolMode === "observe"
        ? observeLineId
        : caller.poolMode === "live" && caller.owner && signedOut && needsAws.has(action)
          ? awsFirstId
          : null,
    spendOld: signedOut
  }
}

/**
 * The owner's AWS sign-in: read now and every 30 s, and every 5 s while a sign-in waits for its approval, for
 * at most 10 minutes. `started` shows a sign-in the owner just started and polls it from then.
 */
const useAwsSession = (read: SandboxesModuleReads["awsSession"], enabled: boolean) => {
  const [session, setSession] = useState<SandboxAwsSession | null>(null)
  const [restart, setRestart] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const step: (pendingSince: number | null) => Effect.Effect<void> = Effect.fn("Sandboxes.pollAwsSession")(function* (
      pendingSince: number | null
    ) {
      const exit = yield* Effect.exit(read)
      const at = yield* Clock.currentTimeMillis
      const value = Exit.isSuccess(exit) ? exit.value : null
      if (value !== null) yield* Effect.sync(() => setSession(value))
      // A failed read changes nothing known, so the 10 minutes keep counting from the first pending read.
      const since = value === null ? pendingSince : value._tag === "SignInPending" ? (pendingSince ?? at) : null
      yield* Effect.sleep(since !== null && at - since < pendingPollFor ? pendingPollEvery : pollEvery)
      return yield* step(since)
    })
    const fiber = Effect.runFork(step(null))
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [read, enabled, restart])
  return {
    session,
    started: (next: SandboxAwsSession) => {
      setSession(next)
      setRestart((value) => value + 1)
    }
  }
}

/** The page's caller, AWS sign-in and what they hold back. Reads the sign-in for the owner of a served pool. */
const useAws = (reads: SandboxesModuleReads, active: boolean) => {
  const caller = useCaller(reads.caller, active)
  const { session, started } = useAwsSession(reads.awsSession, active && caller.owner && caller.poolMode !== null)
  const aws = useMemo(() => awsViewOf(caller, session), [caller, session])
  return { caller, session, started, aws }
}

/**
 * Sign out of AWS beside the signed-in line, after one confirm. A refusal keeps the sheet open and says the hub
 * didn't sign out, or that a reset is running and the hub signs out only after it; success closes it and hands
 * the new sign-in state to `done`.
 */
const SignOutAws = ({
  done,
  signOut
}: {
  readonly done: (next: SandboxAwsSession) => void
  readonly signOut: SandboxesModuleWrites["signOutAws"]
}): ReactElement => {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<"Idle" | "Sending" | "Failed" | "ResetRunning">("Idle")
  const opener = useRef<HTMLButtonElement | null>(null)
  const send = () => {
    setPhase("Sending")
    void Effect.runPromiseExit(Effect.result(signOut)).then((exit) => {
      if (Exit.isSuccess(exit) && Result.isSuccess(exit.value)) {
        setPhase("Idle")
        setOpen(false)
        done(exit.value.success)
      } else {
        const resetRunning =
          Exit.isSuccess(exit) && Result.isFailure(exit.value) && exit.value.failure.reason === "reset_running"
        setPhase(resetRunning ? "ResetRunning" : "Failed")
      }
    })
  }
  return (
    <>
      <Button
        onClick={() => {
          setPhase((current) => (current === "Sending" ? current : "Idle"))
          setOpen(true)
        }}
        ref={opener}
        size="compact"
        variant="quiet"
      >
        Sign out of AWS
      </Button>
      <Sheet.Root onOpenChange={setOpen} open={open} restoreFocus={() => opener.current ?? undefined}>
        <Sheet.Content className="sandboxes-sheet" closeLabel="Close panel" title="Sign the hub out of AWS?">
          <Sheet.Body className="sandboxes-sheet-body">
            <p className="sandboxes-sheet-lead">
              Spend stops updating, and Release, Retry reset and Request to lift the stop wait until someone signs in
              again.
            </p>
            {phase === "Failed" || phase === "ResetRunning" ? (
              <p className="sandboxes-refusal" role="alert">
                {phase === "ResetRunning"
                  ? "A reset is running. Sign out when it finishes."
                  : "The hub didn’t sign out. Try again."}
              </p>
            ) : null}
          </Sheet.Body>
          <Sheet.Footer className="sandboxes-sheet-foot">
            <Button onClick={() => setOpen(false)} variant="secondary">
              Cancel
            </Button>
            <Button disabled={phase === "Sending"} onClick={send} variant="primary">
              Sign out
            </Button>
          </Sheet.Footer>
        </Sheet.Content>
      </Sheet.Root>
    </>
  )
}

/**
 * The quiet lines under the heading: until when the hub is signed in, and why jobs are held back. `signOut`
 * adds Sign out of AWS beside the signed-in line; the pool page passes it for the owner, other pages don't.
 */
const AwsLines = ({
  caller,
  session,
  signOut = null
}: {
  readonly caller: SandboxesCaller
  readonly session: SandboxAwsSession | null
  readonly signOut?: {
    readonly write: SandboxesModuleWrites["signOutAws"]
    readonly done: (next: SandboxAwsSession) => void
  } | null
}): ReactElement => {
  const times = useContext(TimesContext)
  const { heldBy } = useContext(AwsContext)
  return (
    <>
      {caller.owner && session?._tag === "SignedIn" ? (
        <div className="sandboxes-aws-signed-in">
          <span className="sandboxes-aws-line" data-aws-signed-in="">
            <StateLabel
              icon="check"
              label={`Signed in to AWS until ${times.clock(session.expiresAt)}`}
              size="compact"
              tone="positive"
            />
          </span>
          {signOut === null ? null : <SignOutAws done={signOut.done} signOut={signOut.write} />}
        </div>
      ) : null}
      {caller.poolMode === "observe" ? (
        <p className="sandboxes-muted sandboxes-aws-line" data-observe-mode="" id={observeLineId}>
          {observeModeCopy}
        </p>
      ) : null}
      {heldBy("release") === awsFirstId ? (
        <p className="sandboxes-muted sandboxes-aws-line" data-aws-first="" id={awsFirstId}>
          {awsFirstCopy}
        </p>
      ) : null}
    </>
  )
}

/**
 * The AWS sign-in card above the cards: Sign in to AWS while none is held or after one ended, the code and
 * sign-in page while one waits, nothing once signed in. A viewer sees only that the owner signs in.
 */
const AwsSignInCard = ({
  caller,
  session,
  start,
  started
}: {
  readonly caller: SandboxesCaller
  readonly session: SandboxAwsSession | null
  readonly start: SandboxesModuleWrites["startAwsSignIn"] | null
  readonly started: (next: SandboxAwsSession) => void
}): ReactElement | null => {
  const times = useContext(TimesContext)
  const [phase, setPhase] = useState<"Idle" | "Sending" | "Failed">("Idle")
  const press = (effect: SandboxesModuleWrites["startAwsSignIn"]) => {
    setPhase("Sending")
    void Effect.runPromiseExit(effect).then((exit) => {
      if (Exit.isSuccess(exit)) {
        setPhase("Idle")
        started(exit.value)
      } else {
        setPhase("Failed")
      }
    })
  }
  const frame = (card: ReactElement) => (
    <div aria-label="AWS sign-in" className="sandboxes-aws" role="status">
      {card}
    </div>
  )
  if (!caller.owner) {
    return caller.awsSignedIn === false
      ? frame(
          <StateCard eyebrow="Not signed in" title="Sign in to AWS to read spend." tone="neutral">
            The owner signs the hub in to AWS.
          </StateCard>
        )
      : null
  }
  if (session === null) return null
  switch (session._tag) {
    case "SignInPending":
      return frame(
        <StateCard
          action={
            <div className="sandboxes-aws-pending">
              <div className="sandboxes-aws-code">
                <small>Code</small>
                <code className="stacks-mono" data-aws-code="">
                  {session.userCode}
                </code>
              </div>
              <a
                className="sandboxes-console-link sandboxes-link-primary"
                href={session.verificationUri}
                rel="noopener noreferrer"
                target="_blank"
              >
                Open sign-in page
                <Icon decorative name="external-link" />
              </a>
            </div>
          }
          eyebrow="Waiting for you"
          title="Finish signing in to AWS."
          tone="caution"
        >
          {`Open the sign-in page, check the code matches and approve. It expires at ${times.clock(session.expiresAt)}.`}
        </StateCard>
      )
    case "SignInRequired": {
      const ended = session.reason === "ended"
      return frame(
        <StateCard
          action={
            start === null ? undefined : (
              <>
                <Button disabled={phase === "Sending"} onClick={() => press(start)} variant="primary">
                  Sign in to AWS
                </Button>
                {phase === "Failed" ? (
                  <p className="sandboxes-refusal" role="alert">
                    The AWS sign-in didn’t start. Try again.
                  </p>
                ) : null}
              </>
            )
          }
          eyebrow={ended ? "Signed out" : "Not signed in"}
          title={ended ? "The AWS sign-in ended." : "Sign in to AWS to read spend."}
          tone="neutral"
        >
          {ended
            ? "Sign in again to read spend."
            : "The hub signs in to the management account itself; nothing on this computer is used."}
        </StateCard>
      )
    }
    case "SignedIn":
    case "NotConfigured":
    case "Unavailable":
      return null
  }
}

/** Why a write was refused, then what did not change. A refusal for the owner rule or observe mode says so. */
const refusedCopy = (action: Action, reason: SandboxesWriteFailed["reason"] | "defect"): string =>
  reason === "unauthorized"
    ? `Only the pool owner can ${action} here. ${unchangedCopy[action]}`
    : reason === "observe_mode"
      ? `${observeModeCopy} ${unchangedCopy[action]}`
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
  const heldBy = useContext(AwsContext).heldBy(action)
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
        aria-describedby={heldBy ?? undefined}
        className="sandboxes-trigger"
        disabled={disabled || heldBy !== null}
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
            {phase._tag === "Refused" ? (
              <p className="sandboxes-refusal" role="alert">
                {refusedCopy(action, phase.reason)}
              </p>
            ) : null}
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

const accountHref = (accountId: string): string =>
  moduleHref(sandboxesModule, "account", new URLSearchParams({ id: accountId }))

/**
 * "Retry reset, requested by you at 13:05. Waits on an approver." A budget lift reads
 * "Budget lift requested by …" in the same shape.
 */
const requestLine = (times: Times, request: SandboxRequest, viewer: string): string => {
  const by = request.requestedBy === viewer ? "by you" : `by ${request.requestedBy}`
  const lead = request.kind === "BudgetLift" ? "Budget lift requested" : `${request.kind} reset, requested`
  return `${lead} ${by} at ${times.clock(request.requestedAt)}. Waits on ${waitsOn}.`
}

/** "Nothing runs until it’s approved. 1 h left, expires 14:05." The deadline part only when Fleet set one. */
const requestWaits = (times: Times, request: SandboxRequest, now: DateTime.Utc): string =>
  request.expiresAt === null
    ? "Nothing runs until it’s approved."
    : `Nothing runs until it’s approved. ${span(now, request.expiresAt)} left, expires ${times.clock(request.expiresAt)}.`

/**
 * A reset or lift waiting in Fleet / Approvals: the state in words, never a spinner, and a link to Fleet,
 * where it is decided. The account page adds who it waits on and when it expires.
 */
const PendingRequest = ({
  detail,
  now,
  request,
  viewer
}: {
  readonly detail: boolean
  readonly now: DateTime.Utc
  readonly request: SandboxRequest
  readonly viewer: string
}): ReactElement => {
  const times = useContext(TimesContext)
  return (
    <div className="sandboxes-request" data-request="" role={detail ? "status" : undefined}>
      <StateLabel
        data-request-state=""
        icon="clock"
        label="Approval requested"
        size={detail ? "default" : "compact"}
        tone="caution"
      />
      <span data-request-line="">{requestLine(times, request, viewer)}</span>
      {detail ? <span data-request-waits="">{requestWaits(times, request, now)}</span> : null}
      <a className="sandboxes-link" href={moduleHref(fleetHubModule, "approvals")}>
        {`Open “${request.title}” in Fleet / Approvals`}
      </a>
    </div>
  )
}

const RequestsFailed = (): ReactElement => (
  <p className="sandboxes-muted" data-requests-failed="">
    Fleet requests couldn’t be read.
  </p>
)

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

const consoleNote = "Clear the blocker by hand in the console, then retry the reset."

type SpendLimits = NonNullable<Ready["spendLimits"]>

/** Dollars as the cards write them: cents for spend, whole dollars for a whole-dollar limit. */
const money = (usd: number): string => `$${usd.toFixed(2)}`
const limitMoney = (usd: number): string => (Number.isInteger(usd) ? `$${usd}` : money(usd))

/** Percent of the bar's width, which runs to 1.2 times the hard stop so a stop that fired still shows past it. */
const along = (usd: number, limits: SpendLimits): string =>
  `${Math.min(100, (usd / (limits.stop * 1.2)) * 100).toFixed(2)}%`

/** This month's spend against the alarm and the hard stop; last known while the hub isn’t signed in to AWS. */
const SpendBar = ({ limits, spend }: { readonly limits: SpendLimits; readonly spend: SandboxSpend }): ReactElement => {
  const times = useContext(TimesContext)
  const { spendOld } = useContext(AwsContext)
  return (
    <div className="sandboxes-spend" data-spend="">
      <div className="sandboxes-spend-head" data-spend-head="">
        <span>Spend this month</span>
        <b>{money(spend.usd)}</b>
        {spendOld ? (
          <small className="sandboxes-muted" data-spend-old="">
            {`Last known at ${times.clock(DateTime.makeUnsafe(spend.asOf))}`}
          </small>
        ) : null}
      </div>
      <div
        aria-label={`Spend this month ${money(spend.usd)}. Alarm at ${limitMoney(limits.alarm)}, hard stop at ${limitMoney(limits.stop)}.`}
        aria-valuemax={limits.stop}
        aria-valuemin={0}
        aria-valuenow={spend.usd}
        className="sandboxes-spend-track"
        role="meter"
      >
        <span className="sandboxes-spend-fill" data-spend-fill="" style={{ inlineSize: along(spend.usd, limits) }} />
        <span
          aria-hidden="true"
          className="sandboxes-spend-tick"
          style={{ insetInlineStart: along(limits.alarm, limits) }}
        />
        <span
          aria-hidden="true"
          className="sandboxes-spend-tick sandboxes-spend-stop"
          style={{ insetInlineStart: along(limits.stop, limits) }}
        />
      </div>
      <div aria-hidden="true" className="sandboxes-spend-marks">
        <span data-spend-mark="">$0</span>
        <span data-spend-mark="" style={{ insetInlineStart: along(limits.alarm, limits) }}>
          {`${limitMoney(limits.alarm)} alarm`}
        </span>
        <span data-spend-mark="" style={{ insetInlineStart: along(limits.stop, limits) }}>
          {`${limitMoney(limits.stop)} hard stop`}
        </span>
      </div>
    </div>
  )
}

/** Why the owner can't open this account's console now, or null when they can: their lease, free, or quarantined. */
const consoleRefusal = (state: CardState, viewer: string): string | null => {
  switch (state._tag) {
    case "Available":
    case "Quarantined":
      return null
    case "Leased":
      return state.holder === viewer
        ? null
        : `Open console: only the lease holder can sign in. ${state.holder} holds this lease.`
    case "Cleaning":
      return "Open console is unavailable while the account is wiped."
  }
}

/**
 * Links to the access portal's console for the account, as the pool's role, in a new tab. Never handles keys.
 * A link, so the browser opens it as one; a refused console is a disabled button, since a link can't be disabled.
 */
const OpenConsole = ({
  disabled,
  item,
  signIn
}: {
  readonly disabled: boolean
  readonly item: SandboxCard
  readonly signIn: SandboxSignIn
}): ReactElement => {
  const label = `Open console for ${item.name}, AWS access portal as ${signIn.roleName}, opens in a new tab`
  return disabled ? (
    <Button aria-label={label} className="sandboxes-trigger" disabled trailingIcon="external-link" variant="secondary">
      Open console
    </Button>
  ) : (
    <a
      aria-label={label}
      className="sandboxes-trigger sandboxes-console-link"
      href={consoleUrl(signIn, item.accountId)}
      rel="noopener noreferrer"
      target="_blank"
    >
      Open console
      <Icon decorative name="external-link" />
    </a>
  )
}

/** The account's `~/.aws/config` profile, with its own Copy. */
const CliProfile = ({ item, profile }: { readonly item: SandboxCard; readonly profile: string }) => {
  const [failed, setFailed] = useState(false)
  return (
    <div className="sandboxes-cli" data-cli-profile="">
      <div className="sandboxes-cli-box">
        <div className="sandboxes-cli-head">
          <span data-cli-path="">~/.aws/config</span>
          <Button
            aria-label={`Copy CLI profile for ${item.name}`}
            onClick={() => {
              const clipboard = navigator.clipboard
              if (clipboard === undefined) {
                setFailed(true)
                return
              }
              void clipboard.writeText(profile).then(
                () => setFailed(false),
                () => setFailed(true)
              )
            }}
            size="compact"
            variant="secondary"
          >
            Copy
          </Button>
        </div>
        <pre>{profile}</pre>
      </div>
      <small className="sandboxes-muted" data-cli-note="">
        Nix already writes these profiles on managed machines.
      </small>
      {failed ? <p role="alert">Couldn’t copy the CLI profile</p> : null}
    </div>
  )
}

/**
 * The card's owner actions in one row: Open console and Copy CLI profile when the pool has sign-in, Extend
 * and Release on the owner's own lease. The reasons for what is disabled follow in words.
 */
const CardActions = ({
  done,
  item,
  mine,
  now,
  signIn,
  viewer,
  writes
}: {
  readonly done: () => void
  readonly item: SandboxCard
  readonly mine: boolean
  readonly now: DateTime.Utc
  readonly signIn: SandboxSignIn | null
  readonly viewer: string
  readonly writes: SandboxesModuleWrites | null
}): ReactElement => {
  const times = useContext(TimesContext)
  const [cliOpen, setCliOpen] = useState(false)
  const state = item.state
  const refusal = signIn === null ? null : consoleRefusal(state, viewer)
  const profile = signIn === null ? null : cliProfile(signIn, item.name, item.accountId)
  const lease = mine && state._tag === "Leased" ? state : null
  const capped = lease !== null && atCap(lease.startedAt, lease.endsAt)
  return (
    <div className="sandboxes-card-actions">
      <div className="sandboxes-card-buttons">
        {signIn === null ? null : (
          <>
            <OpenConsole disabled={refusal !== null} item={item} signIn={signIn} />
            {profile === null ? null : (
              <Button aria-expanded={cliOpen} onClick={() => setCliOpen((open) => !open)} variant="quiet">
                Copy CLI profile
              </Button>
            )}
          </>
        )}
        {lease === null ? null : <OwnLease done={done} item={item} now={now} state={lease} writes={writes} />}
      </div>
      {refusal === null ? null : (
        <small className="sandboxes-muted" data-console-reason="">
          {refusal}
        </small>
      )}
      {lease !== null && capped ? (
        <small className="sandboxes-muted">{`Extend: 24-hour cap reached at ${times.when(capOf(lease.startedAt), now)}.`}</small>
      ) : null}
      {profile !== null && cliOpen ? <CliProfile item={item} profile={profile} /> : null}
    </div>
  )
}

const PoolCard = ({
  done,
  item,
  lastKnown,
  lift,
  now,
  owner,
  requests,
  signIn,
  spendLimits,
  viewer,
  writes
}: {
  readonly done: () => void
  readonly item: SandboxCard
  /** The pool's alarm and hard stop; with the card's reading, the spend bar. */
  readonly spendLimits: Ready["spendLimits"]
  readonly lastKnown: DateTime.Utc | null
  readonly now: DateTime.Utc
  readonly owner: boolean
  /** The pool's sign-in, for the owner; null for a viewer or a pool without it. */
  readonly signIn: SandboxSignIn | null
  readonly requests: ReadonlyArray<SandboxRequest>
  /** The budget card's lift request, for the owner; null everywhere else. */
  readonly lift: ReactElement | null
  readonly viewer: string
  readonly writes: SandboxesModuleWrites | null
}): ReactElement => {
  const times = useContext(TimesContext)
  const { label, tone } = stateLabel(rankOf(item.state))
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
        <StateLabel
          data-pool-state=""
          data-tone={tone}
          {...(tone === "neutral" ? { icon: "minus" } : {})}
          label={label}
          tone={tone}
        />
      </header>
      {state._tag === "Quarantined" && budgetStopped(state) ? (
        <div className="sandboxes-card-block">
          <p>{budgetHoldWords}</p>
        </div>
      ) : state._tag === "Quarantined" ? (
        <div className="sandboxes-card-block">
          <p>{state.blocker.text}</p>
          <div className="sandboxes-card-line">
            <a className="sandboxes-link" href={accountHref(item.accountId)}>
              Open quarantine
            </a>
            <a className="sandboxes-link" href={runsHref(item)}>
              View run
            </a>
          </div>
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
      {spendLimits === null || item.spend === null ? null : <SpendBar limits={spendLimits} spend={item.spend} />}
      {requests.map((request) => (
        <PendingRequest detail={false} key={request.jobId} now={now} request={request} viewer={viewer} />
      ))}
      {lift}
      {mine || (owner && signIn !== null) ? (
        <CardActions
          done={done}
          item={item}
          mine={mine}
          now={now}
          signIn={owner ? signIn : null}
          viewer={viewer}
          writes={writes}
        />
      ) : null}
    </article>
  )
}

/** Extend and Release for the lease this viewer holds. Extend stays visible at the cap, disabled; the card says why. */
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
    <>
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
    </>
  )
}

const LeaseAction = ({
  done,
  now,
  overview,
  signIn,
  writes
}: {
  readonly done: () => void
  readonly now: DateTime.Utc
  readonly overview: Ready
  readonly signIn: SandboxSignIn | null
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
            ["Extend up to", times.when(capOf(now), now)],
            ...(signIn === null ? [] : [["Signs in as", signIn.roleName] satisfies readonly [string, ReactNode]])
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

/** The caller, once read. A pending or failed read is a viewer with no login, so no lease is "yours". */
const useCaller = (read: SandboxesModuleReads["caller"], active: boolean): SandboxesCaller => {
  const [caller, setCaller] = useState<SandboxesCaller>({
    login: "",
    owner: false,
    signIn: null,
    poolMode: null,
    awsSignedIn: null
  })
  useEffect(() => {
    if (!active) return
    const fiber = Effect.runFork(
      Effect.exit(read).pipe(
        Effect.flatMap((exit) => Effect.sync(() => (Exit.isSuccess(exit) ? setCaller(exit.value) : undefined)))
      )
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [read, active])
  return caller
}

/**
 * One read's result. A failed read before any value is its own state, never an empty list. A later failure
 * keeps the last value and says since when it is last known.
 */
type Read<A> =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failed" }
  | { readonly _tag: "Done"; readonly value: A; readonly staleSince: DateTime.Utc | null }

/** A polled read and a way to read it again now, after a write. */
interface Polled<A> {
  readonly result: Read<A>
  readonly readAgain: () => void
}

const settleRead = <A,>(previous: Read<A>, exit: Exit.Exit<A, SandboxesClientError>, at: DateTime.Utc): Read<A> =>
  Exit.isSuccess(exit)
    ? { _tag: "Done", value: exit.value, staleSince: null }
    : previous._tag === "Done"
      ? { ...previous, staleSince: previous.staleSince ?? at }
      : { _tag: "Failed" }

/**
 * Reads now and every 30 s while the page is active, like the pool. A changed `read`, such as another
 * account, starts from Loading; `readAgain`, after a write, reads now and keeps what is on screen until it
 * answers. `read` must keep its identity, or it reads on every render.
 */
const useRead = <A,>(read: Effect.Effect<A, SandboxesClientError>, active: boolean): Polled<A> => {
  // The result remembers which read it answers, so a changed read is Loading on its first render.
  const [held, setHeld] = useState<{ readonly read: typeof read; readonly result: Read<A> }>({
    read,
    result: { _tag: "Loading" }
  })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!active) return
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(read)
        const at = yield* DateTime.now
        yield* Effect.sync(() =>
          setHeld((previous) => ({
            read,
            result: settleRead(previous.read === read ? previous.result : { _tag: "Loading" }, exit, at)
          }))
        )
      }).pipe(Effect.repeat(Schedule.spaced(pollEvery)))
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [read, active, attempt])
  return {
    result: held.read === read ? held.result : { _tag: "Loading" },
    readAgain: () => setAttempt((value) => value + 1)
  }
}

/** Pending requests by account, and whether they can be acted on: answered, and not last known. */
interface PendingRequests {
  readonly byAccount: ReadonlyMap<string, ReadonlyArray<SandboxRequest>>
  readonly fresh: boolean
  readonly staleSince: DateTime.Utc | null
}

/** A failed first read, or a pool not served here, is null: unknown, not none. */
const pendingRequests = (read: Read<SandboxRequests>): PendingRequests | null => {
  if (read._tag === "Loading") return { byAccount: new Map(), fresh: false, staleSince: null }
  if (read._tag === "Failed" || read.value._tag !== "Ready") return null
  const byAccount = new Map<string, Array<SandboxRequest>>()
  for (const request of read.value.requests) {
    byAccount.set(request.accountId, [...(byAccount.get(request.accountId) ?? []), request])
  }
  return { byAccount, fresh: read.staleSince === null, staleSince: read.staleSince }
}

/** Under requests or runs that a later poll could not refresh. */
const LastKnown = ({
  at,
  of
}: {
  readonly at: DateTime.Utc
  readonly of: "requests" | "runs" | "log"
}): ReactElement => {
  const times = useContext(TimesContext)
  const words = `Last known at ${times.clock(at)}`
  return of === "requests" ? (
    <small className="sandboxes-muted" data-requests-stale="">
      {words}
    </small>
  ) : of === "runs" ? (
    <small className="sandboxes-muted" data-runs-stale="">
      {words}
    </small>
  ) : (
    <small className="sandboxes-muted" data-log-stale="">
      {words}
    </small>
  )
}

type RequestKind = "retry" | "lift"

const requestCopy = {
  retry: {
    trigger: "Retry reset",
    note: "Starts a fresh run. Goes to Fleet / Approvals first.",
    again: "Retry already requested. Nothing new was sent."
  },
  lift: {
    trigger: "Request to lift the stop",
    note: "Goes to Fleet / Approvals. The stop stays until it’s approved.",
    again: "Lift already requested. Nothing new was sent."
  }
} satisfies Record<RequestKind, { readonly trigger: string; readonly note: string; readonly again: string }>

/** Why a retry or lift was not sent, and that nothing changed. A request that may have left says so. */
const requestRefusal = (kind: RequestKind, reason: SandboxesWriteFailed["reason"] | "defect"): string => {
  switch (reason) {
    case "already_requested":
      return requestCopy[kind].again
    case "not_quarantined":
      return "This account isn’t quarantined any more. Nothing was sent."
    case "not_budget_held":
      return "This account isn’t stopped by budget. Nothing was sent."
    case "unauthorized":
      return "Only the pool owner can ask for this here. Nothing was sent."
    case "observe_mode":
      return `${observeModeCopy} Nothing was sent.`
    case "rejected":
      return "Fleet refused the request. Nothing was sent."
    case "network":
    case "defect":
      return "The request may not have reached Fleet. Check Fleet / Approvals before asking again."
  }
}

/**
 * One request to Fleet: a retry or a lift. The approval in Fleet is the confirm, so one press sends it.
 * `done` reads the requests again, so the pending request replaces this button. `beside` sits in the same
 * row, such as Open console, and `besideNote` under the request's own note.
 */
const RequestAction = ({
  beside = null,
  besideNote = null,
  disabled,
  done,
  kind,
  submit,
  variant
}: {
  readonly beside?: ReactElement | null
  readonly besideNote?: string | null
  readonly disabled: boolean
  readonly done: () => void
  readonly kind: RequestKind
  readonly submit: Effect.Effect<void, SandboxesWriteFailed>
  readonly variant: "primary" | "secondary"
}): ReactElement => {
  const [phase, setPhase] = useState<
    | { readonly _tag: "Idle" }
    | { readonly _tag: "Sending" }
    | { readonly _tag: "Refused"; readonly reason: SandboxesWriteFailed["reason"] | "defect" }
  >({ _tag: "Idle" })
  const heldBy = useContext(AwsContext).heldBy(kind)
  const send = () => {
    setPhase({ _tag: "Sending" })
    void Effect.runPromiseExit(Effect.result(submit)).then((exit) => {
      if (Exit.isFailure(exit)) {
        setPhase({ _tag: "Refused", reason: "defect" })
      } else if (Result.isFailure(exit.value)) {
        setPhase({ _tag: "Refused", reason: exit.value.failure.reason })
      } else {
        setPhase({ _tag: "Idle" })
        done()
      }
    })
  }
  return (
    <div className="sandboxes-request-action">
      <div className="sandboxes-request-buttons">
        <Button
          aria-describedby={heldBy ?? undefined}
          className="sandboxes-trigger"
          disabled={disabled || heldBy !== null || phase._tag === "Sending"}
          onClick={send}
          variant={variant}
        >
          {requestCopy[kind].trigger}
        </Button>
        {beside}
      </div>
      <small className="sandboxes-muted" data-request-note="">
        {requestCopy[kind].note}
      </small>
      {besideNote === null ? null : (
        <small className="sandboxes-muted" data-console-note="">
          {besideNote}
        </small>
      )}
      {phase._tag === "Refused" ? (
        <p className="sandboxes-refusal" role="alert">
          {requestRefusal(kind, phase.reason)}
        </p>
      ) : null}
    </div>
  )
}

/** A reset of either kind already waits for this account, so a retry would only ask twice. */
const resetPending = (requests: ReadonlyArray<SandboxRequest>): boolean =>
  requests.some((request) => request.kind === "Retry" || request.kind === "Manual")

const liftPending = (requests: ReadonlyArray<SandboxRequest>): boolean =>
  requests.some((request) => request.kind === "BudgetLift")

const OverviewPage = ({
  mount,
  reads,
  writes
}: {
  readonly mount: ModulePageMount
  readonly reads: SandboxesModuleReads
  readonly writes: SandboxesModuleWrites | null
}): ReactElement => {
  const times = useContext(TimesContext)
  const { aws, caller, session, started } = useAws(reads, mount.active)
  const { login: viewer, owner, signIn } = caller
  const { now, readAgain, view } = usePool(reads.overview, mount.active)
  const requestsRead = useRead(reads.requests, mount.active)
  const requests = pendingRequests(requestsRead.result)
  const pool = view._tag === "Pool" ? view : null
  // A job runs after it is submitted, so the next read can still show the old card; say so for a minute.
  const [submittedAt, setSubmittedAt] = useState<DateTime.Utc | null>(null)
  const submitted = submittedAt !== null && millis(now) - millis(submittedAt) < 60_000
  const reread = () => {
    setSubmittedAt(DateTime.nowUnsafe())
    readAgain(false)
  }
  const count = pool?.overview.sandboxes.length
  // A stale pool is shown as it was read, so its times count from the read, in the header and the notice alike.
  const poolNow = pool !== null && pool.stale ? pool.readAt : now
  const noneFree = pool === null ? null : noneFreeWords(times, pool.overview.sandboxes, poolNow)
  return (
    <AwsContext.Provider value={aws}>
      <section className="sandboxes-page">
        <header className="sandboxes-head">
          <div className="sandboxes-title">
            <h1>Sandboxes</h1>
            {count === undefined ? null : <p>{count === 1 ? "1 account" : `${count} accounts`}</p>}
            {pool === null ? null : (
              <AwsLines
                caller={caller}
                session={session}
                signOut={owner && !pool.stale && writes !== null ? { write: writes.signOutAws, done: started } : null}
              />
            )}
            <div aria-live="polite" role="status">
              {pool !== null && pool.stale ? (
                <StateLabel icon="clock" label={staleWords(pool.readAt, now)} tone="caution" />
              ) : null}
            </div>
          </div>
          {owner && pool !== null ? (
            <LeaseAction
              done={reread}
              now={poolNow}
              overview={pool.overview}
              signIn={signIn}
              writes={pool.stale ? null : writes}
            />
          ) : null}
        </header>
        {pool === null ? null : (
          <AwsSignInCard
            caller={caller}
            session={session}
            start={pool.stale || writes === null ? null : writes.startAwsSignIn}
            started={started}
          />
        )}
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
        {view._tag !== "Pool" ? (
          <PoolPanel readAgain={() => readAgain(true)} view={view} />
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
            {requests === null ? (
              <RequestsFailed />
            ) : requests.staleSince === null ? null : (
              <LastKnown at={requests.staleSince} of="requests" />
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
                  requests={requests?.byAccount.get(item.accountId) ?? []}
                  signIn={owner ? signIn : null}
                  spendLimits={view.overview.spendLimits}
                  lift={
                    owner &&
                    writes !== null &&
                    !view.stale &&
                    budgetStopped(item.state) &&
                    !liftPending(requests?.byAccount.get(item.accountId) ?? []) ? (
                      <RequestAction
                        disabled={requests === null || !requests.fresh}
                        done={requestsRead.readAgain}
                        kind="lift"
                        submit={Effect.suspend(() => writes.liftBudget(item.accountId))}
                        variant="secondary"
                      />
                    ) : null
                  }
                  viewer={viewer}
                  writes={view.stale ? null : writes}
                />
              ))}
            </div>
            <p className="sandboxes-muted sandboxes-policy">{policyLine}</p>
          </div>
        )}
      </section>
    </AwsContext.Provider>
  )
}

/** The page's account id. Anything that is not a 12-digit id is null and reads nothing. */
const accountIdOf = (search: URLSearchParams): SandboxCard["accountId"] | null =>
  Schema.decodeUnknownOption(SandboxCard.fields.accountId)(search.get("id")).pipe((decoded) =>
    decoded._tag === "Some" ? decoded.value : null
  )

const stepWord = (step: RunStep): string => `${step.charAt(0).toUpperCase()}${step.slice(1)}`

/** One step as a list shows it: its words, its state, and the blocker words when it is the step that failed. */
interface StepRow {
  readonly name: string
  readonly state: Labelled
  readonly current: boolean
  readonly blocker: string | null
  /** The stored line of the failed step, for the owner only. */
  readonly raw: string | null
  /** The step's second line, such as "signed in" or "41 to remove, scan complete". */
  readonly outcome: string | null
  /** The clock time of the step's latest report. */
  readonly at: string | null
  /** The failure in plain words, on the failed step. */
  readonly words: string | null
}

const noDetail = { outcome: null, at: null, words: null }

/** Before the failed step done, the failed step failed, after it not run. */
const finishedSteps = (
  names: (step: RunStep, index: number) => string,
  failed: RunStep,
  blocker: string | null
): ReadonlyArray<StepRow> => {
  const at = runSteps.findIndex(({ id }) => id === failed)
  return runSteps.map(({ id }, index) => ({
    name: names(id, index),
    state:
      index < at
        ? { label: "Done", tone: "positive" }
        : index === at
          ? { label: "Failed", tone: "critical" }
          : { label: "Not run", tone: "neutral" },
    current: index === at,
    blocker: index === at ? blocker : null,
    raw: null,
    ...noDetail
  }))
}

/** A step's second line, as page 14 8c writes it; none where the run has no safe words or count for it. */
const stepOutcome = (
  { count, status, step }: SandboxRunView["steps"][number],
  blocker: SandboxRunView["blocker"]
): string | null => {
  if (status === "notRun") return step === "budget hold" ? "not checked" : "not run"
  if (status === "done") {
    switch (step) {
      case "sign in":
        return "signed in"
      case "baseline":
      case "baseline re-check":
        return "matches"
      case "dry run":
        return count === null ? "scan complete" : `${count} to remove, scan complete`
      default:
        return null
    }
  }
  // A failed verify counts what remains only when the blocker says resources remain; an unfinished scan counts nothing.
  return status === "failed" && step === "verify" && count !== null && blocker?._tag === "ResourcesRemain"
    ? `${count} still removable`
    : null
}

/**
 * The failure in the design's plain words, only where the blocker establishes it. A dry run can stop for an
 * incomplete scan or for its guard, a verify for remaining resources or an unfinished scan, and a budget hold for
 * the hold or a failed read, so each gets words only for the blocker that matches them.
 */
const failureWords = (step: RunStep, blocker: SandboxRunView["blocker"]): string | null => {
  switch (step) {
    case "sign in":
      return "Assume role: Relay couldn’t sign in to the account to clean it."
    case "baseline":
      return "Baseline: the account doesn’t match its baseline, so cleanup didn’t start."
    case "dry run":
      return blocker?._tag === "ScanIncomplete" ? "Dry run: the scan didn’t finish, so nothing was removed." : null
    case "nuke":
      return "Nuke: cleanup stopped before everything was removed."
    case "verify":
      return blocker?._tag === "ResourcesRemain" ? "Verify: some resources are still there after cleanup." : null
    case "budget hold":
      return blocker?._tag === "BudgetHold"
        ? "Budget hold: this account passed its monthly spend cap, so it’s locked until an approver lifts the hold. Cleanup still ran."
        : null
    case "baseline re-check":
      return null
  }
}

const statusLabel = (status: SandboxRunView["steps"][number]["status"]): Labelled => {
  switch (status) {
    case "done":
      return { label: "Done", tone: "positive" }
    case "failed":
      return { label: "Failed", tone: "critical" }
    case "running":
      return { label: "In progress", tone: "progress" }
    case "notRun":
      return { label: "Not run", tone: "neutral" }
  }
}

/**
 * What a recorded step adds under its name. The run sheet gives its second line, and on the failed step the plain
 * words, or the blocker's own words where the step has none. The account page gives the time only: its blocker has
 * its own section.
 */
const recordedDetail = (
  run: SandboxRunView,
  step: SandboxRunView["steps"][number],
  show: "outcome" | { readonly times: Times }
): Pick<StepRow, "outcome" | "at" | "words" | "blocker"> => {
  if (show !== "outcome") {
    return { outcome: null, at: step.at === null ? null : show.times.clock(step.at), words: null, blocker: null }
  }
  const words = step.status === "failed" ? failureWords(step.step, run.blocker) : null
  return {
    outcome: stepOutcome(step, run.blocker),
    at: null,
    words,
    blocker: step.status === "failed" && words === null ? (run.blocker?.text ?? null) : null
  }
}

/** Rows from a run's recorded steps: their own status, and either their second line or their time. */
const recordedRows = (
  run: SandboxRunView,
  name: (step: RunStep, index: number) => string,
  show: "outcome" | { readonly times: Times }
): ReadonlyArray<StepRow> =>
  run.steps.map((step, index) => ({
    name: name(step.step, index),
    state: statusLabel(step.status),
    current: step.status === "failed" || step.status === "running",
    raw: null,
    ...recordedDetail(run, step, show)
  }))

/**
 * A run's steps in the run-detail words. A run with recorded steps shows them; an older one is read from its
 * outcome. A running run counts from its current step; a quarantined one from the
 * step that failed. An available run is all done. A quarantine with no failed step names no steps.
 */
const runRows = (run: SandboxRunView): ReadonlyArray<StepRow> | null => {
  const named = (_step: RunStep, index: number) => runSteps[index]?.name ?? ""
  if (run.steps.length > 0) return recordedRows(run, named, "outcome")
  if (run.outcome === null) {
    const current = runSteps.findIndex(({ id }) => id === run.step)
    return runSteps.map(({ name }, index) => ({
      name,
      state: stepState(index, current),
      current: index === current,
      blocker: null,
      raw: null,
      ...noDetail
    }))
  }
  // A failed step that was retried still names failedStep; an available run passed every step.
  if (run.outcome === "Available") {
    return runSteps.map(({ name }) => ({
      name,
      state: { label: "Done", tone: "positive" },
      current: false,
      blocker: null,
      raw: null,
      ...noDetail
    }))
  }
  return run.failedStep === null ? null : finishedSteps(named, run.failedStep, run.blocker?.text ?? null)
}

const StepList = ({ label, rows }: { readonly label: string; readonly rows: ReadonlyArray<StepRow> }): ReactElement => (
  <ol aria-label={label} className="sandboxes-steps">
    {rows.map(({ at, blocker, current, name, outcome, raw, state, words }, index) => (
      <li aria-current={current ? "step" : undefined} key={name}>
        <span aria-hidden="true" className="sandboxes-step-number">
          {index + 1}
        </span>
        <span className="sandboxes-step-text">
          <span data-step-name="">{name}</span>
          {outcome === null ? null : <small data-step-outcome="">{outcome}</small>}
        </span>
        <span className="sandboxes-step-end">
          {at === null ? null : <small data-step-at="">{at}</small>}
          <StateLabel
            data-step-state=""
            {...(state.tone === "neutral" ? { icon: "minus" } : {})}
            label={state.label}
            size="compact"
            tone={state.tone}
          />
        </span>
        {words === null ? null : (
          <p className="sandboxes-step-blocker" data-step-words="">
            {words}
          </p>
        )}
        {blocker === null ? null : (
          <p className="sandboxes-step-blocker" data-step-blocker="">
            {blocker}
          </p>
        )}
        {raw === null ? null : (
          <code className="sandboxes-step-raw" data-step-raw="">
            {raw}
          </code>
        )}
      </li>
    ))}
  </ol>
)

/** Loading, failed and not-set-up, the same on every page. Null once the pool has been read. */
const PoolPanel = ({ readAgain, view }: { readonly readAgain: () => void; readonly view: PoolView }) =>
  view._tag === "Loading" ? (
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
      <Button onClick={readAgain} variant="primary">
        Read again
      </Button>
    </section>
  ) : view._tag === "NotSetUp" ? (
    <section className="sandboxes-panel">
      <StateLabel icon="minus" label={notSetUpCopy(view.where, view.host).label} tone="neutral" />
      <h2>{notSetUpCopy(view.where, view.host).title}</h2>
    </section>
  ) : null

const BackToPool = (): ReactElement => (
  <a className="sandboxes-back" data-back="" href={moduleHref(sandboxesModule, "overview")}>
    <span aria-hidden="true">←</span>
    <span>Sandboxes</span>
  </a>
)

const NotInPool = ({ id }: { readonly id: string }): ReactElement => (
  <section className="sandboxes-panel">
    <h2>{`No account ${id} in this pool.`}</h2>
    <a className="sandboxes-link" href={moduleHref(sandboxesModule, "overview")}>
      Back to the pool
    </a>
  </section>
)

/** The account's runs, read once while the page is active. Nothing is read for an id that is not one. */
const useRuns = (
  reads: SandboxesModuleReads,
  id: SandboxCard["accountId"] | null,
  active: boolean
): Read<SandboxRuns> => {
  const read = useMemo(() => (id === null ? Effect.never : reads.runs(id)), [reads.runs, id])
  return useRead(read, active && id !== null).result
}

/** The owner's log of the open run. Nothing is read without an account and a run, so never for a viewer. */
const useRunLog = (
  reads: SandboxesModuleReads,
  id: SandboxCard["accountId"] | null,
  runId: SandboxRunView["runId"] | null,
  active: boolean
): Read<SandboxRunLog> => {
  const read = useMemo(
    () => (id === null || runId === null ? Effect.never : reads.runLog(id, runId)),
    [reads.runLog, id, runId]
  )
  return useRead(read, active && id !== null && runId !== null).result
}

/** The owner's Open console on a quarantined account, and the note under it: none for a budget stop. */
interface AccountConsole {
  readonly button: ReactElement
  readonly note: string | null
}

const accountConsole = (item: SandboxCard, signIn: SandboxSignIn | null): AccountConsole | null =>
  signIn === null || item.state._tag !== "Quarantined"
    ? null
    : {
        button: <OpenConsole disabled={false} item={item} signIn={signIn} />,
        note: budgetStopped(item.state) ? null : consoleNote
      }

/**
 * Retry for a quarantine, lift for a budget stop, for the owner, when no request of that kind waits. It is
 * disabled until the requests are read and current, so a last-known "none" never asks twice.
 */
const accountAction = (
  item: SandboxCard,
  requests: PendingRequests | null,
  writes: SandboxesModuleWrites | null,
  done: () => void,
  openConsole: AccountConsole | null
): ReactElement | null => {
  if (writes === null || item.state._tag !== "Quarantined") return null
  const pending = requests?.byAccount.get(item.accountId) ?? []
  const disabled = requests === null || !requests.fresh
  if (budgetStopped(item.state)) {
    return liftPending(pending) ? null : (
      <RequestAction
        beside={openConsole?.button ?? null}
        besideNote={openConsole?.note ?? null}
        disabled={disabled}
        done={done}
        kind="lift"
        submit={Effect.suspend(() => writes.liftBudget(item.accountId))}
        variant="primary"
      />
    )
  }
  return resetPending(pending) ? null : (
    <RequestAction
      beside={openConsole?.button ?? null}
      besideNote={openConsole?.note ?? null}
      disabled={disabled}
      done={done}
      kind="retry"
      submit={Effect.suspend(() => writes.retry(item.accountId))}
      variant="primary"
    />
  )
}

/** Why the account cannot be cleaned, and what is already asked of Fleet. Budget stops are caution, not red. */
const AccountDetail = ({
  action,
  item,
  now,
  openConsole,
  requests,
  requestsSince,
  runs,
  spendLimits,
  viewer
}: {
  /** The owner's retry or lift request for this account, when one can be asked for. */
  readonly action: ReactElement | null
  /** The owner's Open console; beside the action when there is one, else under the requests. */
  readonly openConsole: AccountConsole | null
  readonly item: SandboxCard
  readonly now: DateTime.Utc
  readonly requests: ReadonlyArray<SandboxRequest> | null
  /** When the requests on screen became last known; null while they are current. */
  readonly requestsSince: DateTime.Utc | null
  readonly runs: Read<SandboxRuns>
  readonly spendLimits: Ready["spendLimits"]
  readonly viewer: string
}): ReactElement => {
  const times = useContext(TimesContext)
  const state = item.state
  const { label, tone } = stateLabel(rankOf(state))
  const run =
    state._tag === "Quarantined" && runs._tag === "Done" && runs.value._tag === "Ready"
      ? runs.value.runs.find((candidate) => candidate.runId === state.runId)
      : undefined
  const since = run?.endedAt === undefined || run.endedAt === null ? null : times.since(run.endedAt, now)
  const failed = run?.failedStep ?? null
  const summary =
    state._tag !== "Quarantined"
      ? null
      : budgetStopped(state)
        ? budgetHoldWords
        : `The reset failed${failed === null ? "" : ` at ${stepWord(failed)}`}.${
            since === null ? " Quarantined;" : ` Quarantined since ${since};`
          } no one can lease it until a reset passes.`
  return (
    <div className="sandboxes-account">
      <header className="sandboxes-account-head">
        <div className="sandboxes-account-title">
          <h1>{item.name}</h1>
          <StateLabel data-account-state="" data-tone={tone} label={label} tone={tone} />
        </div>
        <div className="sandboxes-card-id">
          <code>{item.accountId}</code>
          <CopyAccountId accountId={item.accountId} />
        </div>
        {summary === null ? null : <p data-account-summary="">{summary}</p>}
      </header>
      {action === null ? null : <div className="sandboxes-account-actions">{action}</div>}
      {requests === null ? (
        <RequestsFailed />
      ) : (
        requests.map((request) => (
          <PendingRequest detail key={request.jobId} now={now} request={request} viewer={viewer} />
        ))
      )}
      {action !== null || openConsole === null ? null : (
        <div className="sandboxes-account-actions">
          {openConsole.button}
          {openConsole.note === null ? null : (
            <small className="sandboxes-muted" data-console-note="">
              {openConsole.note}
            </small>
          )}
        </div>
      )}
      {requestsSince === null ? null : <LastKnown at={requestsSince} of="requests" />}
      {state._tag === "Quarantined" && !budgetStopped(state) ? (
        <div className="sandboxes-account-body">
          <div className="sandboxes-account-main">
            <section className="sandboxes-account-section">
              <h2>Blocker</h2>
              <p data-account-blocker="">{state.blocker.text}</p>
            </section>
            {failed === null ? null : (
              <section className="sandboxes-account-section">
                <h2>Reset run</h2>
                <StepList
                  label="Reset steps"
                  rows={
                    run !== undefined && run.steps.length > 0
                      ? recordedRows(run, stepWord, { times })
                      : finishedSteps(stepWord, failed, null)
                  }
                />
              </section>
            )}
          </div>
          <Facts
            rows={[
              ["Run ID", <code>{state.runId}</code>],
              ...(since === null ? [] : [["Since", since] satisfies readonly [string, ReactNode]]),
              ...(failed === null ? [] : [["Failed step", stepWord(failed)] satisfies readonly [string, ReactNode]]),
              ...(item.spend === null
                ? []
                : [["Spend this month", money(item.spend.usd)] satisfies readonly [string, ReactNode]])
            ]}
          />
        </div>
      ) : state._tag === "Quarantined" ? (
        spendLimits === null || item.spend === null ? null : (
          <div className="sandboxes-account-spend">
            <SpendBar limits={spendLimits} spend={item.spend} />
            {item.spend.usd < spendLimits.stop ? null : (
              <small className="sandboxes-muted" data-spend-over="">
                {`${money(item.spend.usd)} is past the ${limitMoney(spendLimits.stop)} hard stop.`}
              </small>
            )}
          </div>
        )
      ) : (
        <Facts rows={cardRows(times, item, viewer, now)} />
      )}
      {runs._tag === "Done" && runs.staleSince !== null ? <LastKnown at={runs.staleSince} of="runs" /> : null}
      <a className="sandboxes-link" href={runsHref(item)}>
        View runs
      </a>
    </div>
  )
}

/**
 * One account: the needs-you destination. The owner may ask Fleet to retry a quarantine's reset or to lift
 * a budget stop; either waits for an approval in Fleet / Approvals.
 */
const AccountPage = ({
  mount,
  reads,
  search,
  writes
}: {
  readonly mount: ModulePageMount
  readonly reads: SandboxesModuleReads
  readonly search: URLSearchParams
  readonly writes: SandboxesModuleWrites | null
}): ReactElement => {
  const { aws, caller, session } = useAws(reads, mount.active)
  const { login: viewer, owner, signIn } = caller
  const id = accountIdOf(search)
  const { now, readAgain, view } = usePool(reads.overview, mount.active)
  const requestsRead = useRead(reads.requests, mount.active)
  const requests = pendingRequests(requestsRead.result)
  const runs = useRuns(reads, id, mount.active)
  const item =
    view._tag === "Pool" ? view.overview.sandboxes.find((candidate) => candidate.accountId === id) : undefined
  return (
    <AwsContext.Provider value={aws}>
      <section className="sandboxes-page">
        <BackToPool />
        {view._tag === "Pool" ? <AwsLines caller={caller} session={session} /> : null}
        {view._tag !== "Pool" ? (
          <PoolPanel readAgain={() => readAgain(true)} view={view} />
        ) : item === undefined ? (
          <NotInPool id={search.get("id") ?? ""} />
        ) : (
          <AccountDetail
            action={accountAction(
              item,
              requests,
              owner && !view.stale ? writes : null,
              requestsRead.readAgain,
              accountConsole(item, owner ? signIn : null)
            )}
            openConsole={accountConsole(item, owner ? signIn : null)}
            item={item}
            now={view.stale ? view.readAt : now}
            requests={requests === null ? null : (requests.byAccount.get(item.accountId) ?? [])}
            requestsSince={requests?.staleSince ?? null}
            runs={runs}
            spendLimits={view.overview.spendLimits}
            viewer={viewer}
          />
        )}
      </section>
    </AwsContext.Provider>
  )
}

const outcomeLabel = (outcome: SandboxRunView["outcome"]): Labelled =>
  outcome === null
    ? { label: "In progress", tone: "progress" }
    : outcome === "Quarantined"
      ? { label: "Quarantined", tone: "critical" }
      : { label: "Available", tone: "neutral" }

const runHref = (accountId: string, runId: string): string =>
  moduleHref(sandboxesModule, "runs", new URLSearchParams({ id: accountId, run: runId }))

/** The owner's log of one run: its last lines, oldest first, each with its clock time. */
const RunLog = ({ log }: { readonly log: Read<SandboxRunLog> }): ReactElement => {
  const times = useContext(TimesContext)
  if (log._tag === "Loading") {
    return (
      <p className="sandboxes-muted" data-run-log-state="" role="status">
        Reading the log…
      </p>
    )
  }
  if (log._tag === "Failed" || log.value._tag !== "Ready") {
    return (
      <p className="sandboxes-muted" data-run-log-state="">
        Can’t read the log.
      </p>
    )
  }
  const { lines } = log.value
  return (
    <details className="sandboxes-log" data-run-log="" open>
      <summary>
        <span aria-hidden="true" className="sandboxes-log-marker">
          ▼
        </span>
        <span>Log</span>
        <small>{lines.length === 1 ? "Last 1 line" : `Last ${lines.length} lines`}</small>
      </summary>
      <pre>{lines.map(({ at, text }) => `${times.seconds(at)} ${text}`).join("\n")}</pre>
      {log.staleSince === null ? null : <LastKnown at={log.staleSince} of="log" />}
    </details>
  )
}

/**
 * One run, opened from its row. The failed step carries its blocker words. `log` is the owner's read of the
 * run's log and stored failure line; null for anyone else, who sees neither.
 */
const RunSheet = ({
  close,
  item,
  log,
  now,
  run
}: {
  readonly close: () => void
  readonly item: SandboxCard
  readonly log: Read<SandboxRunLog> | null
  readonly now: DateTime.Utc
  readonly run: SandboxRunView
}): ReactElement => {
  const times = useContext(TimesContext)
  const outcome = outcomeLabel(run.outcome)
  const raw = log !== null && log._tag === "Done" && log.value._tag === "Ready" ? log.value.raw : null
  // The stored line goes on the step that failed.
  const rows = runRows(run)?.map((row) => (row.state.tone === "critical" ? { ...row, raw } : row)) ?? null
  return (
    <Sheet.Root onOpenChange={(open) => (open ? undefined : close())} open>
      <Sheet.Content className="sandboxes-sheet" closeLabel="Close run" title="Cleanup run">
        <Sheet.Body className="sandboxes-sheet-body">
          <code>{run.runId}</code>
          <StateLabel label={outcome.label} tone={outcome.tone} />
          <Facts
            rows={[
              ["Account", <Value main={item.name} sub={item.accountId} />],
              ["Reason", run.reason],
              ["Started", times.since(run.startedAt, now)],
              ["Ended", run.endedAt === null ? "Still running" : times.since(run.endedAt, now)]
            ]}
          />
          <h3>Steps</h3>
          {rows === null ? (
            <>
              <p data-step-blocker="">{run.blocker?.text ?? ""}</p>
              {raw === null ? null : (
                <code className="sandboxes-step-raw" data-step-raw="">
                  {raw}
                </code>
              )}
            </>
          ) : (
            <StepList label="Cleanup steps" rows={rows} />
          )}
          {log === null ? null : <RunLog log={log} />}
        </Sheet.Body>
      </Sheet.Content>
    </Sheet.Root>
  )
}

/** One account's recent runs: reason, outcome, duration, started. A row opens that run. */
const RunsPage = ({
  mount,
  reads,
  search
}: {
  readonly mount: ModulePageMount
  readonly reads: SandboxesModuleReads
  readonly search: URLSearchParams
}): ReactElement => {
  const times = useContext(TimesContext)
  const id = accountIdOf(search)
  const { now, readAgain, view } = usePool(reads.overview, mount.active)
  const runs = useRuns(reads, id, mount.active)
  const { owner } = useCaller(reads.caller, mount.active)
  const item =
    view._tag === "Pool" ? view.overview.sandboxes.find((candidate) => candidate.accountId === id) : undefined
  const page = runs._tag === "Done" && runs.value._tag === "Ready" ? runs.value : null
  const open = page?.runs.find((run) => run.runId === search.get("run"))
  const log = useRunLog(reads, owner && id !== null ? id : null, open?.runId ?? null, mount.active)
  return (
    <section className="sandboxes-page">
      <BackToPool />
      {view._tag !== "Pool" ? (
        <PoolPanel readAgain={() => readAgain(true)} view={view} />
      ) : item === undefined ? (
        <NotInPool id={search.get("id") ?? ""} />
      ) : (
        <>
          <header className="sandboxes-head">
            <div className="sandboxes-title">
              <h1>{item.name}</h1>
            </div>
          </header>
          {runs._tag === "Loading" ? (
            <p className="sandboxes-muted" data-runs-loading="" role="status">
              Reading runs…
            </p>
          ) : page === null ? (
            <section className="sandboxes-panel">
              <StateLabel label="Can’t read" tone="critical" />
              <h2>Can’t read runs.</h2>
            </section>
          ) : (
            <section aria-label="Recent runs" className="sandboxes-runs">
              <div className="sandboxes-runs-head">
                <h2>Recent runs</h2>
                <small>{page.runs.length === 1 ? "Last cleanup run" : `Last ${page.runs.length} cleanup runs`}</small>
              </div>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Duration</th>
                    <th scope="col">Started</th>
                  </tr>
                </thead>
                <tbody>
                  {page.runs.map((run) => {
                    const outcome = outcomeLabel(run.outcome)
                    const started = times.since(run.startedAt, now)
                    return (
                      <tr key={run.runId}>
                        <td>
                          <a
                            aria-label={`${item.name}, ${run.reason}, ${outcome.label}, started ${started}. Open run ${run.runId}`}
                            className="sandboxes-link"
                            href={runHref(item.accountId, run.runId)}
                          >
                            {item.name}
                          </a>
                        </td>
                        <td>{run.reason}</td>
                        <td>
                          <StateLabel label={outcome.label} size="compact" tone={outcome.tone} />
                        </td>
                        <td>{span(run.startedAt, run.endedAt ?? now)}</td>
                        <td>{started}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {runs._tag === "Done" && runs.staleSince !== null ? <LastKnown at={runs.staleSince} of="runs" /> : null}
            </section>
          )}
          {open === undefined ? null : (
            <RunSheet
              close={() =>
                mount.navigate(
                  moduleHref(sandboxesModule, "runs", new URLSearchParams({ id: item.accountId })),
                  "replace"
                )
              }
              item={item}
              log={owner ? log : null}
              now={now}
              run={open}
            />
          )}
        </>
      )}
    </section>
  )
}

/**
 * Overview for the shell. `reads.caller` says whether the reader is the owner (the hub's own node, or an
 * allowed login on the owner's own device) and gives their login, matched against a lease holder. `writes` is null where the hub cannot submit sandbox jobs.
 */
export const makeSandboxesModuleViews = ({
  reads,
  timeZone,
  writes
}: {
  readonly reads: SandboxesModuleReads
  /** The viewer's IANA time zone; every clock time and day on the page is in it. */
  readonly timeZone: string
  readonly writes: SandboxesModuleWrites | null
}): ModuleViews<typeof sandboxesModule> => {
  const times = timesIn(timeZone)
  return {
    descriptor: sandboxesModule,
    navigationIcon: <ShellIcon name="sandboxes" />,
    pages: {
      overview: (_search, mount) => (
        <TimesContext value={times}>
          <OverviewPage mount={mount} reads={reads} writes={writes} />
        </TimesContext>
      ),
      account: (search, mount) => (
        <TimesContext value={times}>
          <AccountPage mount={mount} reads={reads} search={search} writes={writes} />
        </TimesContext>
      ),
      runs: (search, mount) => (
        <TimesContext value={times}>
          <RunsPage mount={mount} reads={reads} search={search} />
        </TimesContext>
      )
    }
  }
}
