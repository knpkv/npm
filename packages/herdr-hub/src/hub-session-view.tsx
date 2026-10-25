/**
 * Who is logged in to the hub, drawn from page 22 "Identity and sign-in".
 *
 * Only copy that is true now ships: nothing is enforced and there are no passkeys yet, so the design's
 * "view only" wording, its "You can" list and the fleet host's agents line wait for the PRs that make them
 * true. A loopback page without a session keeps the shell's existing session line.
 *
 * @module
 */
import { Button, StateLabel } from "@knpkv/rly/primitives"
import { Effect } from "effect"
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type {
  HubSessionChangeFailed,
  HubSessionReadFailed,
  HubSessionView,
  SessionTokenStore
} from "./hub-session-client.js"
import { takeLoginFragment } from "./hub-session-client.js"

/** What the page needs from `/v1/session`, with the HTTP client already provided. */
export interface HubSessionActions {
  readonly load: Effect.Effect<HubSessionView, HubSessionReadFailed>
  readonly logIn: Effect.Effect<void, HubSessionChangeFailed>
  readonly logOut: (csrf: string) => Effect.Effect<void, HubSessionChangeFailed>
  readonly spendLoginCode: (code: string) => Effect.Effect<void, HubSessionChangeFailed>
}

/** How often an open page reads its session again; each read renews a sliding session on the hub. */
const pollMillis = 60_000

/**
 * The page's session: read on load (after spending a `#login=` code, taken out of the address first), again
 * every minute and when the page becomes visible. A failed read keeps what the page last knew.
 */
export const useHubSession = (actions: HubSessionActions) => {
  const [view, setView] = useState<HubSessionView | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const refresh = useCallback(() => {
    void Effect.runPromise(
      actions.load.pipe(Effect.match({ onFailure: () => undefined, onSuccess: (next) => setView(next) }))
    )
  }, [actions])
  useEffect(() => {
    const code = takeLoginFragment(window.location, window.history)
    void Effect.runPromise(
      // A refused or unreachable exchange leaves the page as it was, logged out; the log says why.
      (code === null ? Effect.void : actions.spendLoginCode(code).pipe(Effect.ignore({ log: true }))).pipe(
        Effect.andThen(Effect.sync(refresh))
      )
    )
    const timer = window.setInterval(refresh, pollMillis)
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
      if (view?.signedIn === true) change(actions.logOut(view.csrf))
    }
  }
}

/** The loopback page's session token, in this tab's session storage; unavailable storage keeps nothing. */
export const browserTokenStore = (key = "herdr-hub-session"): SessionTokenStore => ({
  read: () => {
    try {
      return window.sessionStorage.getItem(key)
    } catch {
      return null
    }
  },
  write: (token) => {
    try {
      window.sessionStorage.setItem(key, token)
    } catch {
      // Storage refused (private mode, quota): the page stays logged out, as before the code was spent.
    }
  },
  clear: () => {
    try {
      window.sessionStorage.removeItem(key)
    } catch {
      // Nothing was kept.
    }
  }
})

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
  /** Closes the popover: Escape, or a press outside the control and the popover. */
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
  const popover = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
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
  }, [open, onClose])
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
        onClick={onToggle}
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
            <div className="hub-session-pop" role="dialog" aria-label="Your session" ref={popover}>
              <SessionDetails view={view} onLogOut={onLogOut} {...(timeZone === undefined ? {} : { timeZone })} />
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

/**
 * Page 22's log-in card for a Tailscale person who isn't logged in: continue as the WhoIs login on this
 * device. Nothing for a logged-in person or the local user.
 */
export const TailscaleLoginCard = ({
  busy,
  onLogIn,
  view
}: {
  readonly view: HubSessionView
  readonly busy: boolean
  readonly onLogIn: () => void
}): ReactElement | null => {
  if (view.signedIn || view.kind !== "tailscale") return null
  const device = view.device === undefined ? "" : `Tailscale says this is ${view.device}. `
  return (
    <section className="hub-login-card" role="status">
      <StateLabel icon="minus" label="Not logged in" tone="neutral" />
      <h2>{`Continue as ${view.login}?`}</h2>
      <p>{`${device}Logging in keeps you signed in here for 8 hours.`}</p>
      <Button variant="primary" disabled={busy} onClick={onLogIn}>
        Log in with Tailscale
      </Button>
    </section>
  )
}
