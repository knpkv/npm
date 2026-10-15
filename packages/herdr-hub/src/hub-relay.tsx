/**
 * Relay in the hub's masthead: the launcher with Relay's mark and status, and its panel.
 *
 * **Mental model**
 *
 * - **One fleet conversation.** The hub holds `{ product: "herdr", kind: "fleet", id: <hub host> }`; the page
 *   opens its stream once and every part of it reads that one.
 * - **The mark is the launcher.** The shell selects a static Chef; legacy callers keep the phase-driven
 *   Creature. Expanded button styling shows the open state. Existing words carry Relay's status. They are announced only while the panel is closed: once it is open,
 *   its transcript announces the runs.
 * - **Ctrl/⌘+J opens Relay, except in Connect,** where the terminal owns the key. Escape closes Relay
 *   either way.
 * - **The panel is an overlay** on wide screens and full screen on a phone; it isn't pinned here yet.
 *
 * @module
 */
import type { ObjectRef } from "@knpkv/relay/wire"
import { Creature } from "@knpkv/herdr-connect/surface"
import {
  type RelayConversations,
  RelayConversationPanel,
  type RelayStatusView,
  type RelayConversationState,
  useRelayConversation,
  useRelayStatus
} from "@knpkv/relay-product/client"
import { RelayLauncher, useRelayPresentation, useRelayShortcut, useRelaySummon } from "@knpkv/rly/patterns"
import { Button, Text } from "@knpkv/rly/primitives"
import { type ReactElement, useCallback, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { RelayChefMark } from "./internal/relay-chef-mark.js"

type RelayPhase = "idle" | "listening" | "thinking" | "answering" | "needs-you"

/** Use status precedence without interpreting its display words; a quiet focused input means listening. */
const relayPhase = (state: RelayConversationState, status: RelayStatusView, focused: boolean): RelayPhase => {
  const phases = {
    attention: (): RelayPhase => "needs-you",
    working: (): RelayPhase => {
      if (state.runIds.length > 0 && state.tools.some((tool) => tool.state === "running")) return "thinking"
      if (state.runIds.length > 0 && state.messages.at(-1)?.streaming === true) return "answering"
      return "thinking"
    },
    unread: (): RelayPhase => "idle",
    idle: (): RelayPhase => (state.connection === "live" && state.failure === null && focused ? "listening" : "idle")
  } satisfies Record<RelayStatusView["activity"], () => RelayPhase>
  return phases[status.activity]()
}

/** Creature understands Fleet states; every Relay phase maps explicitly, never through its string fallback. */
const creatureState = (phase: RelayPhase): "idle" | "ready" | "working" | "waiting" => {
  const states = {
    idle: "idle",
    listening: "ready",
    thinking: "working",
    answering: "working",
    "needs-you": "waiting"
  } satisfies Record<RelayPhase, "idle" | "ready" | "working" | "waiting">
  return states[phase]
}

const RelayAvatar = ({ phase }: { readonly phase: RelayPhase }): ReactElement => (
  <span className="hub-relay-avatar" data-relay-phase={phase}>
    <Creature host="relay" id="assistant" size="row" state={creatureState(phase)} />
  </span>
)

/** What the shell needs to show Relay: the page's conversations and the hub's one conversation. */
export interface HubRelayConversation {
  readonly conversations: RelayConversations
  readonly conversation: ObjectRef
}

/**
 * Ties the page's Relay streams to its lifecycle: a page that is really going away stops them; one the
 * browser keeps in its back/forward cache keeps them, and when it comes back the conversation reopens if its
 * stream ended while the page was frozen. Returns the unsubscribe.
 */
export const watchRelayPage = (
  view: Pick<Window, "addEventListener" | "removeEventListener">,
  relay: HubRelayConversation
): (() => void) => {
  const hide = (event: PageTransitionEvent): void => {
    if (!event.persisted) relay.conversations.dispose()
  }
  const show = (event: PageTransitionEvent): void => {
    if (event.persisted) relay.conversations.retry(relay.conversation)
  }
  view.addEventListener("pagehide", hide)
  view.addEventListener("pageshow", show)
  return () => {
    view.removeEventListener("pagehide", hide)
    view.removeEventListener("pageshow", show)
  }
}

/**
 * What the closed launcher's live region says: the status words, re-said only when what Relay is doing changes.
 * While a run works, its words flip between "Reading…", "Answering…" and "Working…" at every tool boundary;
 * the words beside the mark follow them, but each run is announced once, when it starts. A message waiting to
 * be sent ("Sending…") is not a run, so the run it starts is announced too.
 */
const useSpokenStatus = (
  status: RelayStatusView,
  runIds: ReadonlyArray<string>
): { readonly key: string; readonly words: string } => {
  const key =
    status.activity === "working" && runIds.length > 0 ? `run:${JSON.stringify(runIds)}` : (status.words ?? "")
  const [spoken, setSpoken] = useState({ key, words: status.words ?? "" })
  // Stored during render when the key changes, so the region never renders the old words for a new state.
  if (spoken.key !== key) setSpoken({ key, words: status.words ?? "" })
  return spoken.key === key ? spoken : { key, words: status.words ?? "" }
}

/** Relay's launcher, status and panel for the masthead. */
export const HubRelay = ({
  announcementOutlet = null,
  launcherLabels,
  launcherMark = "creature",
  relay,
  terminalOwnsKeys
}: {
  /** Defaults to null, beside the launcher. A supplied shell outlet keeps the persistent live status outside the visual mast. */
  readonly announcementOutlet?: HTMLElement | null
  readonly relay: HubRelayConversation
  /** The Connect tab shows: its terminal keeps Ctrl/⌘+J. */
  readonly terminalOwnsKeys: boolean
  /** Optional shell names: desktop button and phone brand. Both announce the desktop action name. */
  readonly launcherLabels?: { readonly desktop: string; readonly phone: string }
  /** Creature by default. Chef is static; open styling and the existing status words retain their meanings. */
  readonly launcherMark?: "creature" | "chef"
}): ReactElement => {
  const [open, setOpen] = useState(false)
  const [composerFocused, setComposerFocused] = useState(false)
  const changeOpen = useCallback((open: boolean): void => {
    if (!open) setComposerFocused(false)
    setOpen(open)
  }, [])
  const launcher = useRef<HTMLButtonElement>(null)
  const keys = useRelayShortcut()
  const shortcut = terminalOwnsKeys ? null : keys
  const { presentation } = useRelayPresentation({ minHostWidth: 0, pinned: false })
  const { composerRef, regionRef } = useRelaySummon({
    fullscreen: presentation === "fullscreen",
    launcher,
    onOpenChange: changeOpen,
    open,
    shortcut
  })
  const status = useRelayStatus(relay.conversations, relay.conversation, open)
  const state = useRelayConversation(relay.conversations, relay.conversation)
  const spoken = useSpokenStatus(status, state.runIds)
  const phase = relayPhase(state, status, open && composerFocused)
  const avatar = <RelayAvatar phase={phase} />
  const announcement = (
    <>
      {/* The status is announced here only while the panel is closed; once open, its transcript speaks. */}
      <span aria-live="polite" className="fleet-shell-relay-live" role="status">
        {/* Keyed by what is announced: a new run with the same words is a new node, so it is said again. */}
        {open ? null : <span key={spoken.key}>{spoken.words}</span>}
      </span>
    </>
  )
  return (
    <div className="fleet-shell-relay">
      <RelayLauncher
        activity={status.activity}
        avatar={launcherMark === "chef" ? <RelayChefMark /> : avatar}
        {...(launcherLabels === undefined
          ? {}
          : {
              label: presentation === "fullscreen" ? launcherLabels.phone : launcherLabels.desktop,
              "aria-label": launcherLabels.desktop
            })}
        expanded={open}
        onClick={() => changeOpen(!open)}
        ref={launcher}
        shortcut={shortcut}
      />
      {status.words === null ? null : (
        <span className="fleet-shell-relay-status">
          <Text tone="secondary" variant="meta">
            {status.words}
          </Text>
          {status.line === null ? null : (
            <Text tone="secondary" variant="meta">
              {status.line}
            </Text>
          )}
        </span>
      )}
      {announcementOutlet === null ? announcement : createPortal(announcement, announcementOutlet)}
      {open ? (
        <RelayConversationPanel
          avatar={avatar}
          {...(launcherLabels === undefined ? {} : { title: launcherLabels.desktop })}
          {...(status.words !== null
            ? { avatarStatus: status.words }
            : phase === "listening"
              ? { avatarStatus: "Listening" }
              : {})}
          transcriptAvatar={({ live }) => <RelayAvatar phase={live ? phase : "idle"} />}
          onComposerFocusChange={setComposerFocused}
          composerRef={composerRef}
          conversation={relay.conversation}
          conversations={relay.conversations}
          launcher={launcher}
          onClose={() => changeOpen(false)}
          placeholder="Ask Relay about your agents, approvals or work"
          presentation={presentation}
          regionRef={regionRef}
          scope={{ label: `Fleet on ${relay.conversation.id}` }}
          signedOut={{
            description:
              "Relay answers on this hub's own address, for the people allowed on it. Open the hub from your tailnet again.",
            action: (
              <Button onClick={() => window.location.reload()} type="button" variant="primary">
                Reload
              </Button>
            )
          }}
        />
      ) : null}
    </div>
  )
}
