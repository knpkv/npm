/**
 * Who is logged in to the hub, drawn from page 22 "Identity and sign-in".
 *
 * The whole hub is behind login: a browser without a session gets the login gate ({@link LoginGatePage}) and
 * no hub page. There are no passkeys yet, so the design's "You can" list waits for the PR that makes it true.
 *
 * @module
 */
import { RelayMark } from "@knpkv/rly/patterns"
import { Button, Notice, StateLabel } from "@knpkv/rly/primitives"
import { Effect } from "effect"
import { type ReactElement, useCallback, useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { HubSessionChangeFailed, HubSessionReadFailed, HubSessionView } from "./hub-session-client.js"
import { takeLoginFragment } from "./hub-session-client.js"
import type { CsrfStore } from "./session-csrf.js"

/** What the page needs from `/v1/session`, with the HTTP client already provided. */
export interface HubSessionActions {
  readonly load: Effect.Effect<HubSessionView, HubSessionReadFailed>
  readonly logIn: Effect.Effect<void, HubSessionChangeFailed>
  readonly logOut: (csrf: string) => Effect.Effect<void, HubSessionChangeFailed>
  readonly spendLoginCode: (code: string) => Effect.Effect<void, HubSessionChangeFailed>
  /** Where the page's other clients find the session's CSRF token for their writes. */
  readonly csrf: CsrfStore
}

/**
 * Orders overlapping reads: `begin` starts one and returns whether it is still the latest started, so an
 * older read that finishes last doesn't replace a newer result.
 */
export const latestOnly = () => {
  let started = 0
  return {
    begin: () => {
      started += 1
      const mine = started
      return () => mine === started
    }
  }
}

/** How often a visible page reads its session again; each read renews a sliding session on the hub. */
const pollMillis = 60_000

/**
 * The page's session: read on load (after spending a `#login=` code, taken out of the address first), again
 * every minute and when the page becomes visible. A failed read keeps what the page last knew. A session that
 * lapses under an open page reloads it: the hub then serves the login gate. Each read that lands also sets the
 * page's CSRF token (`actions.csrf`): a log-in fills it, a switch to another session replaces it, and a log-out
 * clears it as soon as the hub confirms.
 */
export const useHubSession = (actions: HubSessionActions) => {
  const [view, setView] = useState<HubSessionView | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [reads] = useState(latestOnly)
  const refresh = useCallback(() => {
    // Reads overlap (the minute's read, the one after a log-in): only the latest one started may land.
    const isLatest = reads.begin()
    void Effect.runPromise(
      actions.load.pipe(
        Effect.match({
          onFailure: () => undefined,
          onSuccess: (next) => {
            if (!isLatest()) return
            actions.csrf.remember(next)
            setView((previous) => {
              if (previous?.signedIn === true && !next.signedIn) window.location.reload()
              return next
            })
          }
        })
      )
    )
  }, [actions, reads])
  useEffect(() => {
    const code = takeLoginFragment(window.location, window.history)
    void Effect.runPromise(
      // A refused or unreachable exchange leaves the page as it was, logged out; the log says why.
      (code === null ? Effect.void : actions.spendLoginCode(code).pipe(Effect.ignore({ log: true }))).pipe(
        Effect.andThen(Effect.sync(refresh))
      )
    )
    // A hidden tab doesn't read: a forgotten background tab must not keep a session alive to the 7-day cap.
    // Becoming visible reads at once.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh()
    }, pollMillis)
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [actions, refresh])
  const change = (effect: Effect.Effect<void, HubSessionChangeFailed>) => {
    setBusy(true)
    void Effect.runPromise(
      // A failed log-in or log-out leaves the session as the next read finds it; page 22 draws no error
      // state for it yet, so the log says why.
      effect.pipe(
        Effect.ignore({ log: true }),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
        Effect.andThen(Effect.sync(refresh))
      )
    )
  }
  return {
    view,
    busy,
    open,
    toggle: () => setOpen((current) => !current),
    close: () => setOpen(false),
    logIn: () => change(actions.logIn),
    logOut: () => {
      setOpen(false)
      if (view?.signedIn === true) change(actions.logOut(view.csrf).pipe(Effect.tap(Effect.sync(actions.csrf.forget))))
    }
  }
}

/** `node` rendered into `root` when there is one, in place otherwise. */
const inRoot = (root: Element | undefined, node: ReactElement): ReactElement =>
  root === undefined ? node : createPortal(node, root)

/** A login's display name: its local part, capitalized ("Owner" for owner@example.test). */
const displayName = (login: string): string => {
  const local = login.split("@", 1)[0] ?? login
  return `${local.slice(0, 1).toUpperCase()}${local.slice(1)}`
}

/** 24-hour hours and minutes in `timeZone` (the browser's own by default). */
const clock = (millis: number, timeZone?: string): string =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(millis)

/**
 * The shell's session control: the logged-in person (or this computer) and when the session ends, opening a
 * popover with who, how, until when and Log out. A Tailscale person who isn't logged in is named, without a
 * popover; the login card offers the log-in. Null for a loopback page without a session.
 */
export const SessionControl = ({
  onClose,
  onLogOut,
  onToggle,
  open,
  overlayRoot,
  timeZone,
  view
}: {
  readonly view: HubSessionView
  readonly open: boolean
  readonly onToggle: () => void
  /**
   * Closes the popover: on Escape, a press outside the control and the popover, Log out, or focus leaving
   * it. Escape and Log out put focus back on the control; a press elsewhere or focus leaving keeps it there.
   */
  readonly onClose: () => void
  readonly onLogOut: () => void
  /**
   * Where the popover renders: the page passes the document body, because the sidebar is a sticky stacking
   * context and the page's cards would paint over it there. Without one it renders in place.
   */
  readonly overlayRoot?: Element
  readonly timeZone?: string
}): ReactElement | null => {
  const anchor = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const popoverId = useId()
  const closeToControl = useCallback(() => {
    onClose()
    trigger.current?.focus()
  }, [onClose])
  // Opening moves focus into the popover, to its first control (Log out): it renders at the end of the body.
  useEffect(() => {
    if (open) popover.current?.querySelector("button")?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeToControl()
    }
    // A press elsewhere goes where it was aimed: the popover closes without taking focus back.
    const onPointer = (event: PointerEvent) => {
      const path = event.composedPath()
      const inside = [anchor.current, popover.current].some((node) => node !== null && path.includes(node))
      if (!inside) onClose()
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("pointerdown", onPointer)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("pointerdown", onPointer)
    }
  }, [open, closeToControl, onClose])
  if (!view.signedIn) {
    if (view.kind === "local") return null
    const where = view.device === undefined ? "" : ` on ${view.device}`
    return (
      <div
        className="superapp-session hub-session"
        role="group"
        aria-label={`Your Tailscale session${where}, not logged in`}
      >
        <span className="superapp-session-avatar" aria-hidden="true">
          {view.login.slice(0, 1)}
        </span>
        <span aria-hidden="true">
          {displayName(view.login)}
          <small>Not logged in</small>
        </span>
      </div>
    )
  }
  const until = clock(view.expiresAt, timeZone)
  const tailscale = view.kind === "tailscale"
  const label = tailscale
    ? `Your Tailscale session, ${view.login}${view.device === undefined ? "" : ` on ${view.device}`}, logged in until ${until}`
    : `This computer, logged in until ${until}`
  return (
    <div className="hub-session-anchor" ref={anchor}>
      <button
        type="button"
        className="superapp-session hub-session"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={onToggle}
        ref={trigger}
      >
        <span className="superapp-session-avatar" aria-hidden="true">
          {tailscale ? view.login.slice(0, 1) : ""}
        </span>
        <span aria-hidden="true">
          {tailscale ? displayName(view.login) : "This computer"}
          <small>{`Logged in until ${until}`}</small>
        </span>
        <span className="superapp-session-online" data-state="connected" aria-hidden="true" />
      </button>
      {open
        ? inRoot(
            overlayRoot,
            <div
              className="hub-session-pop"
              role="dialog"
              aria-label="Your session"
              id={popoverId}
              tabIndex={-1}
              ref={popover}
              onBlur={(event) => {
                // Tab past Log out leaves the popover: close it rather than leave it open behind the page.
                const next = event.relatedTarget
                if (next === null || (popover.current?.contains(next) !== true && next !== trigger.current)) onClose()
              }}
            >
              <SessionDetails
                view={view}
                onLogOut={() => {
                  onLogOut()
                  trigger.current?.focus()
                }}
                {...(timeZone === undefined ? {} : { timeZone })}
              />
            </div>
          )
        : null}
    </div>
  )
}

/**
 * Who, how and until when a logged-in session runs, and Log out: the popover's content. Nothing for a session
 * that isn't logged in.
 */
export const SessionDetails = ({
  onLogOut,
  timeZone,
  view
}: {
  readonly view: HubSessionView
  readonly onLogOut: () => void
  readonly timeZone?: string
}): ReactElement | null => {
  if (!view.signedIn) return null
  const tailscale = view.kind === "tailscale"
  return (
    <>
      <div className="hub-session-details">
        {tailscale ? <b>{view.login}</b> : null}
        {tailscale && view.device !== undefined ? (
          <span className="hub-session-pop-meta">{`Logged in with Tailscale on ${view.device}`}</span>
        ) : null}
        <span className="hub-session-pop-meta">{`Until ${clock(view.expiresAt, timeZone)}`}</span>
      </div>
      <div className="hub-session-details">
        <Button variant="quiet" onClick={onLogOut}>
          Log out
        </Button>
      </div>
    </>
  )
}

/** Page 22's gate copy: the Tailscale card, the local user's command, and the lines above and inside them. */
const gateCopy = {
  eyebrow: "Not logged in",
  sessionEnded: "Your session ended. Log in again to continue.",
  fleetHost: "This computer runs agents. They keep working; only you, logged in here, can see and act.",
  tailscaleBody: "Logging in keeps you signed in here for 8 hours.",
  logIn: "Log in with Tailscale",
  localTitle: "Log in as local user",
  localBody: "Run this in a terminal on this computer. It opens this page logged in.",
  command: "herdr-hub login",
  copy: "Copy"
}

/**
 * Page 22's login gate, the whole page for a browser without a session: the Relay mark, a caution line when a
 * session ended, and one card. Over Tailscale the card offers to continue as the WhoIs login (with the
 * fleet-host line on a fleet machine); on loopback it gives the `herdr-hub login` command. Nothing for a
 * logged-in session.
 */
export const LoginGate = ({
  busy,
  onCopy,
  onLogIn,
  view
}: {
  readonly view: HubSessionView
  readonly busy: boolean
  readonly onLogIn: () => void
  /** Copies the command; absent where there is no clipboard (server rendering, tests). */
  readonly onCopy?: (text: string) => void
}): ReactElement | null => {
  const headingId = useId()
  if (view.signedIn) return null
  const tailscale = view.kind === "tailscale"
  return (
    <main className="hub-login-gate">
      <div className="hub-login-gate-body">
        <div className="hub-login-gate-mark">
          <RelayMark.Tile size={24} />
          <span>Relay</span>
        </div>
        {view.ended === true ? <Notice tone="caution">{gateCopy.sessionEnded}</Notice> : null}
        <section className="hub-login-gate-card" aria-labelledby={headingId}>
          <StateLabel icon="minus" label={gateCopy.eyebrow} tone="neutral" />
          {tailscale ? (
            <>
              <h1 id={headingId}>{`Continue as ${view.login}?`}</h1>
              <p>
                {view.device === undefined
                  ? gateCopy.tailscaleBody
                  : `Tailscale says this is ${view.device}. ${gateCopy.tailscaleBody}`}
              </p>
              {view.fleetHost === true ? <p className="hub-login-gate-line">{gateCopy.fleetHost}</p> : null}
              <Button variant="primary" disabled={busy} onClick={onLogIn}>
                {gateCopy.logIn}
              </Button>
            </>
          ) : (
            <>
              <h1 id={headingId}>{gateCopy.localTitle}</h1>
              <p>{gateCopy.localBody}</p>
              <div className="hub-login-gate-command">
                <code>{gateCopy.command}</code>
                <Button
                  variant="secondary"
                  aria-label={`Copy ${gateCopy.command}`}
                  onClick={() => onCopy?.(gateCopy.command)}
                >
                  {gateCopy.copy}
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  )
}

/**
 * The page the hub serves a browser without a session: reads the session (spending a `#login=` code first),
 * draws the gate, and reloads into the hub once logged in.
 */
export const LoginGatePage = ({ actions }: { readonly actions: HubSessionActions }): ReactElement | null => {
  const session = useHubSession(actions)
  const view = session.view
  useEffect(() => {
    if (view?.signedIn === true) window.location.reload()
  }, [view])
  if (view === null) return null
  return (
    <LoginGate
      view={view}
      busy={session.busy}
      onLogIn={session.logIn}
      onCopy={(text) => void navigator.clipboard.writeText(text)}
    />
  )
}
