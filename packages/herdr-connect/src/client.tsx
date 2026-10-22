import {
  type ConnectionState,
  terminalAttachUrl,
  terminalConnectionAfterClose
} from "./internal/terminal-connection.js"
import { useAtom, useAtomMount, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { BrowserHttpClient } from "@effect/platform-browser"
import { Button, StateLabel, Surface, Text } from "@knpkv/rly/primitives"
import { Icon } from "@knpkv/rly/foundations"
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { Cause, Effect, Fiber, Predicate, Result, Schedule, Schema, type Types } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import * as Atom from "effect/reactivity/Atom"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import { FitAddon, init, Terminal } from "ghostty-web"
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode
} from "react"
import { applyTerminalInputIdentity, focusTerminalInput, trackTerminalInputFocus } from "./terminal-input-identity.js"
import { type TerminalDimensions, terminalResizeCommand } from "./terminal-dimensions.js"
import {
  type ConnectAgent,
  type ConnectAgentCursor,
  FleetConnectAgentPage,
  FleetConnectAgents,
  type TerminalClientCommand,
  TerminalServerSignal
} from "./model.js"
import { makePendingTerminalInput } from "./terminal-input.js"
import {
  bindTerminalInteraction,
  type TerminalInteraction,
  type TerminalInteractionView
} from "./terminal-interaction.js"
import { TerminalTextLayer } from "./terminal-overlays.js"
import {
  makeTerminalInputHandler,
  makeTerminalOutputBoundary,
  type TerminalOutputBoundary,
  writeTerminalOutput
} from "./terminal-output.js"
import { agentBucketsOf, type AgentBuckets, arrivalsBetween, nextAgentBuckets } from "./arrivals.js"
import { arrangePins, observePins, pin, type Pin, type Pins, StoredPins, unpin } from "./pins.js"
import { AgentCast, AgentStage, PIN_ROOM, PinnedAgents } from "./stage.js"
import {
  AgentDirectory,
  connectAgentKey,
  connectAgentIdentityAmbiguous,
  ConnectSummary,
  silentHostsSentence,
  ConnectWorkspace,
  TerminalKeyRail,
  type AgentActivityFilter
} from "./view.js"
import { acquireTerminalSetup, ConnectTerminalSetupError } from "./terminal-setup.js"
import { terminalBackground, terminalForeground } from "./terminal-theme.js"
import { bindTerminalDocumentLock, bindTerminalViewport, terminalViewportBindingActive } from "./terminal-viewport.js"
import {
  type ConnectTargetSelection,
  type RememberedConnectPreference,
  connectTargetSelection,
  connectTargetSelectionMatches,
  sameConnectTargetSelection,
  resolveConnectPreferenceDecision
} from "./target.js"
import { nextConnectAgentIndex } from "./keyboard.js"
import {
  applyTerminalModifierToInput,
  dispatchTerminalKey,
  noTerminalModifiers,
  toggleTerminalModifier,
  type TerminalInputApplication,
  type TerminalCursorMode,
  type TerminalModifier,
  type TerminalModifiers,
  type TerminalRailKey
} from "./terminal-keyboard.js"
import { WorkSnapshots, WorkSnapshotsNewerVersion } from "@knpkv/herdr-work/model"
import { ConnectAgentIdentity } from "./work-goal-link-view.js"
import { resolveConnectWorkGoal, workSnapshotForAssociation, type ConnectWorkGoalResolution } from "./work-goal-link.js"
import { WorkPollMount } from "./work-poll.js"
import { limitsState, loadLimits } from "./fleet-reads-client.js"
import { ConnectArchiveSurface } from "./archive-view.js"
import { loadConnectArchive } from "./archive-client.js"
import {
  connectDirectoryHref,
  ConnectDirectorySwitch,
  useConnectDirectoryLocation,
  type ConnectDirectoryLocation
} from "./directory-view.js"
import { ConnectLimits } from "./limits-view.js"
import { ConnectHomeDirectory, connectHomePurpose } from "./home-directory.js"
import { makeTerminalWorkerGuard } from "./terminal-worker-guard.js"
import {
  connectWorkspaceFocusFailureMessage,
  enterTerminalWorkspaceWithLock,
  returnToDirectoryWorkspace,
  type ConnectWorkspaceElements,
  type ConnectWorkspaceFocusFailureReason,
  type ConnectWorkspaceFocusTransition
} from "./workspace-focus.js"

class ConnectNetworkError extends Schema.TaggedError<ConnectNetworkError>()("ConnectNetworkError", {
  detail: Schema.String
}) {}

class ConnectTimeoutError extends Schema.TaggedError<ConnectTimeoutError>()("ConnectTimeoutError", {}) {}

class ConnectStatusError extends Schema.TaggedError<ConnectStatusError>()("ConnectStatusError", {
  status: Schema.Number
}) {}

class ConnectProtocolError extends Schema.TaggedError<ConnectProtocolError>()("ConnectProtocolError", {
  detail: Schema.String,
  cause: Schema.Defect()
}) {}

class ConnectPreferenceError extends Schema.TaggedError<ConnectPreferenceError>()("ConnectPreferenceError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** The clipboard could not be read: no clipboard API here, or the reader refused or failed. */
class ConnectClipboardError extends Schema.TaggedError<ConnectClipboardError>()("ConnectClipboardError", {
  reason: Schema.Literals(["unavailable", "refused"]),
  cause: Schema.Defect()
}) {}

/**
 * Start reading the clipboard now, inside the tap that asked: iOS shows its Paste confirmation only
 * for a read begun within the gesture. The result is awaited later as an Effect.
 */
const startClipboardRead = (): Effect.Effect<string, ConnectClipboardError> => {
  const clipboard = Predicate.hasProperty(window.navigator, "clipboard") ? window.navigator.clipboard : undefined
  if (clipboard === undefined || !Predicate.isFunction(clipboard.readText)) {
    return Effect.fail(new ConnectClipboardError({ reason: "unavailable", cause: "navigator.clipboard.readText" }))
  }
  const reading = clipboard.readText()
  return Effect.tryPromise({
    try: () => reading,
    catch: (cause) => new ConnectClipboardError({ reason: "refused", cause })
  })
}

class ConnectInputQueueError extends Schema.TaggedError<ConnectInputQueueError>()("ConnectInputQueueError", {
  detail: Schema.String
}) {}

type ConnectionRequest = {
  readonly agent: ConnectAgent
  readonly id: number
  readonly takeover?: boolean
  readonly retainStage?: boolean
}

const RememberedAgentKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(513))
const rememberedAgentStorageKey = "fleet-connect-agent"

const loadRememberedAgent = Effect.try({
  try: () => window.localStorage.getItem(rememberedAgentStorageKey),
  catch: (cause) =>
    new ConnectPreferenceError({
      operation: "local_storage.read",
      cause
    })
}).pipe(
  Effect.flatMap((value) =>
    value === null
      ? Effect.succeed(null)
      : Schema.decodeUnknownEffect(RememberedAgentKey)(value).pipe(
          Effect.mapError(
            (cause) =>
              new ConnectPreferenceError({
                operation: "local_storage.decode",
                cause
              })
          )
        )
  )
)

const storeRememberedAgent = (key: string) =>
  Schema.decodeUnknownEffect(RememberedAgentKey)(key).pipe(
    Effect.mapError(
      (cause) =>
        new ConnectPreferenceError({
          operation: "local_storage.encode",
          cause
        })
    ),
    Effect.flatMap((value) =>
      Effect.try({
        try: () => window.localStorage.setItem(rememberedAgentStorageKey, value),
        catch: (cause) =>
          new ConnectPreferenceError({
            operation: "local_storage.write",
            cause
          })
      })
    )
  )

/** Whether the window is phone-narrow (below 48rem), following resizes. */
const narrowQuery = "(max-width: 47.99rem)"
const useNarrowScreen = (): boolean =>
  useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(narrowQuery)
      query.addEventListener("change", onChange)
      return () => query.removeEventListener("change", onChange)
    },
    () => window.matchMedia(narrowQuery).matches,
    () => false
  )

/** The agents this device keeps pinned, in pin order (`Pins`); nothing stored means none. */
const pinsStorageKey = "fleet-connect-pins"
/** Before pins were a set, one pinned agent's key was stored here; it is read once and carried over. */
const legacyPinStorageKey = "fleet-connect-pinned"

const readStorage = (key: string) =>
  Effect.try({
    try: () => window.localStorage.getItem(key),
    catch: (cause) => new ConnectPreferenceError({ operation: "local_storage.read", cause })
  })

const loadPins = Effect.gen(function* () {
  const stored = yield* readStorage(pinsStorageKey)
  if (stored !== null) {
    const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredPins))(stored).pipe(
      Effect.mapError((cause) => new ConnectPreferenceError({ operation: "local_storage.decode", cause }))
    )
    return decoded.pins
  }
  const legacy = yield* readStorage(legacyPinStorageKey)
  if (legacy === null) return []
  const key = yield* Schema.decodeUnknownEffect(RememberedAgentKey)(legacy).pipe(
    Effect.mapError((cause) => new ConnectPreferenceError({ operation: "local_storage.decode", cause }))
  )
  // The old key held only `host:id`; the name and last-seen minute fill in on the first poll that lists it,
  // and until then the pin says it hasn't been seen rather than inventing a time.
  const split = key.indexOf(":")
  const id = split > 0 ? key.slice(split + 1) : key
  const carried: Pin = { host: split > 0 ? key.slice(0, split) : key, id, key, name: id, seenAt: null }
  return [carried]
})

/** Writes the pins, and drops the old single-pin key once they are stored. */
const storePins = (pins: Pins) =>
  Schema.encodeEffect(Schema.fromJsonString(StoredPins))({ pins, v: 1 }).pipe(
    Effect.mapError((cause) => new ConnectPreferenceError({ operation: "local_storage.encode", cause })),
    Effect.flatMap((encoded) =>
      Effect.try({
        try: () => {
          window.localStorage.setItem(pinsStorageKey, encoded)
          window.localStorage.removeItem(legacyPinStorageKey)
        },
        catch: (cause) => new ConnectPreferenceError({ operation: "local_storage.write", cause })
      })
    )
  )

/** Whether this device hides the terminal key rail's keys; nothing stored means shown, as before. */
const TerminalKeysVisibility = Schema.Literals(["shown", "hidden"])
const terminalKeysStorageKey = "fleet-connect-terminal-keys"

const loadTerminalKeysHidden = Effect.try({
  try: () => window.localStorage.getItem(terminalKeysStorageKey),
  catch: (cause) => new ConnectPreferenceError({ operation: "local_storage.read", cause })
}).pipe(
  Effect.flatMap((value) =>
    value === null
      ? Effect.succeed(false)
      : Schema.decodeUnknownEffect(TerminalKeysVisibility)(value).pipe(
          Effect.map((visibility) => visibility === "hidden"),
          Effect.mapError((cause) => new ConnectPreferenceError({ operation: "local_storage.decode", cause }))
        )
  )
)

const storeTerminalKeysHidden = (hidden: boolean) =>
  Effect.try({
    try: () => window.localStorage.setItem(terminalKeysStorageKey, hidden ? "hidden" : "shown"),
    catch: (cause) => new ConnectPreferenceError({ operation: "local_storage.write", cause })
  })

/** One line for a failure a person reads: the error's own message, never a stack trace. */
const causeSummary = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  if (Schema.is(ConnectTimeoutError)(error)) return "the directory request timed out"
  if (Schema.is(ConnectStatusError)(error)) return `HTTP ${String(error.status)}`
  if (Schema.is(ConnectNetworkError)(error) || Schema.is(ConnectProtocolError)(error)) return error.detail
  return Predicate.hasProperty(error, "message") && Predicate.isString(error.message) && error.message.length > 0
    ? error.message
    : String(error)
}

const loadAgents = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const agents: Array<ConnectAgent> = []
  const failures: Array<(typeof FleetConnectAgents.Type)["failures"][number]> = []
  let hosts: (typeof FleetConnectAgents.Type)["hosts"]
  let cursor: ConnectAgentCursor | null = null
  do {
    const path: string =
      cursor === null
        ? "/v1/connect/agents"
        : `/v1/connect/agents?cursorHost=${encodeURIComponent(cursor.host)}&cursorId=${encodeURIComponent(cursor.id)}`
    const response: HttpClientResponse.HttpClientResponse = yield* client
      .get(path)
      .pipe(Effect.mapError((cause) => new ConnectNetworkError({ detail: String(cause) })))
    if (response.status < 200 || response.status >= 300) {
      return yield* new ConnectStatusError({ status: response.status })
    }
    const page: typeof FleetConnectAgentPage.Type = yield* decodeBoundedResponseJson(
      response,
      FleetConnectAgentPage
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ConnectProtocolError({
            detail: "invalid fleet agent directory page",
            cause
          })
      )
    )
    for (const agent of page.agents) agents.push(agent)
    for (const failure of page.failures) failures.push(failure)
    if (page.hosts !== undefined) hosts = page.hosts
    cursor = page.nextCursor
  } while (cursor !== null)
  const fields: Types.Mutable<typeof FleetConnectAgents.Type> = {
    agents,
    failures
  }
  if (hosts !== undefined) fields.hosts = hosts
  const directory = yield* Schema.decodeUnknownEffect(FleetConnectAgents)(fields).pipe(
    Effect.mapError(
      (cause) =>
        new ConnectProtocolError({
          detail: "invalid fleet agent directory",
          cause
        })
    )
  )
  // Lineage issues are labelled per row. They must not hide independently valid agent identities.
  return directory
}).pipe(
  Effect.timeout("10 seconds"),
  Effect.catchTag("TimeoutError", () => Effect.fail(new ConnectTimeoutError()))
)

const loadWork = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const response = yield* client
    .get("/v1/work")
    .pipe(Effect.mapError((cause) => new ConnectNetworkError({ detail: String(cause) })))
  if (response.status < 200 || response.status >= 300) {
    return yield* new ConnectStatusError({ status: response.status })
  }
  // A newer hub format that no longer decodes is named as such: this tab predates the hub, so reloading fixes it.
  const decoded = yield* decodeBoundedResponseJson(
    response,
    Schema.Union([WorkSnapshots, WorkSnapshotsNewerVersion])
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ConnectProtocolError({
          detail: "invalid Work snapshot",
          cause
        })
    )
  )
  if (Schema.is(WorkSnapshots)(decoded)) return decoded
  return yield* new ConnectProtocolError({
    detail: `the hub sends Work snapshot version ${String(decoded.version)}, newer than this page reads: reload the page`,
    cause: decoded
  })
})

const browserRuntime = Atom.runtime(BrowserHttpClient.layerFetch)

export {
  Creature,
  type CreatureAccessory,
  type CreatureHueFamily,
  type CreatureMood,
  type CreatureProps,
  type CreatureReaction
} from "./creature.js"
export { ConnectLimits } from "./limits-view.js"
export { AgentCast, AgentStage, PinnedAgents } from "./stage.js"
export { UsageTab, type UsageTabProps } from "./usage-view.js"

/** The shared agent state language, for hosts that list agents outside Connect (the hub's dashboard). */
export {
  type AgentBucket,
  agentBucketLabel,
  agentBuckets,
  AgentStateLabel,
  type AgentStatePresentation,
  agentStatePresentation
} from "./agent-state.js"

export { Creature as AgentCreature } from "./creature.js"

export const makeConnectAtoms = () => {
  const agents = browserRuntime.atom(loadAgents)
  const work = browserRuntime.atom(loadWork)
  const limits = browserRuntime.atom(loadLimits)
  return {
    activityFilter: Atom.make<AgentActivityFilter>("all"),
    archivePage: browserRuntime.fn(loadConnectArchive),
    agents,
    // A pending read owns its deadline; polling must not interrupt and restart it every five seconds.
    agentsPoll: browserRuntime.atom(
      Effect.gen(function* () {
        const current = yield* Atom.get(agents)
        if (!current.waiting) yield* Atom.refresh(agents)
      }).pipe(Effect.repeat(Schedule.spaced("5 seconds")))
    ),
    connection: Atom.make<ConnectionState>({ _tag: "idle" }),
    connectionRequest: Atom.make<ConnectionRequest | null>(null),
    hostFilter: Atom.make<string | null>(null),
    limits,
    // Each host rereads its limits at most every 30 seconds; a minute keeps the page within two reads.
    limitsPoll: browserRuntime.atom(Atom.refresh(limits).pipe(Effect.repeat(Schedule.spaced("60 seconds")))),
    preference: Atom.make(loadRememberedAgent),
    terminalKeysHidden: Atom.make(loadTerminalKeysHidden),
    pinned: Atom.make(loadPins),
    preferenceError: Atom.make<string | null>(null),
    query: Atom.make(""),
    selectedKey: Atom.make<string | null>(null),
    work,
    workPoll: browserRuntime.atom(Atom.refresh(work).pipe(Effect.repeat(Schedule.spaced("5 seconds"))))
  }
}

export type ConnectAtoms = ReturnType<typeof makeConnectAtoms>

/** Fleet's visible limits panel owns its read and poll; Home has no limits subscription. */
const ConnectLimitsOwner = ({ atoms }: { readonly atoms: ConnectAtoms }) => {
  useAtomMount(atoms.limitsPoll)
  const limits = limitsState(useAtomValue(atoms.limits), Date.now())
  return <ConnectLimits problem={limits.problem} view={limits.view} />
}

const socketUrl = (agent: ConnectAgent, dimensions: TerminalDimensions, takeover: boolean): string =>
  terminalAttachUrl(agent, dimensions, window.location.href, takeover)

type TerminalInputCommand = Extract<TerminalClientCommand, { readonly type: "terminal.input" }>

type TerminalKeyboardCallbacks = {
  readonly getModifier: () => TerminalModifiers
  readonly setModifier: (modifier: TerminalModifiers) => void
  readonly setTerminalFocus: (target: HTMLElement, focus: () => void) => () => void
  readonly reportError: (error: TerminalInputApplication) => void
  readonly setInputSender: (sendInput: (command: TerminalInputCommand) => boolean) => () => void
  /** Registers the terminal's paste, which brackets the text when the program asked for it. */
  readonly setPaste: (paste: (text: string) => void) => () => void
  readonly setCursorModeReader: (read: () => TerminalCursorMode) => () => void
  readonly interactionView: TerminalInteractionView
  readonly setInteraction: (interaction: TerminalInteraction) => () => void
}

const renderTerminalOutput = (
  terminal: Terminal,
  data: Uint8Array,
  outputBoundary: TerminalOutputBoundary,
  onError: (error: ConnectProtocolError) => void
): void => {
  Effect.runFork(
    Effect.try({
      try: () => {
        writeTerminalOutput(terminal, data, outputBoundary)
      },
      catch: (cause) =>
        new ConnectProtocolError({
          detail: "terminal output could not be rendered",
          cause
        })
    }).pipe(Effect.catch((error) => Effect.sync(() => onError(error))))
  )
}

const terminalWorker = (
  container: HTMLElement,
  agent: ConnectAgent,
  update: (state: ConnectionState) => void,
  keyboard: TerminalKeyboardCallbacks,
  takeover: boolean
) =>
  Effect.scoped(
    Effect.gen(function* () {
      update({ _tag: "connecting", agent })
      yield* Effect.tryPromise({
        try: init,
        catch: (cause) =>
          new ConnectProtocolError({
            detail: "Ghostty Web failed to initialize",
            cause
          })
      })
      const terminal = yield* acquireTerminalSetup(
        () => {
          const value = new Terminal({
            cols: 100,
            rows: 30,
            cursorBlink: true,
            fontFamily: "Geist Mono, ui-monospace, monospace",
            fontSize: 13,
            theme: {
              background: terminalBackground,
              foreground: terminalForeground,
              cursor: "#9dd6c5",
              selectionBackground: "#27433c"
            }
          })
          const fit = new FitAddon()
          value.loadAddon(fit)
          value.open(container)
          value.blur()
          fit.fit()
          fit.observeResize()
          return { fit, terminal: value }
        },
        ({ fit, terminal }) => {
          fit.dispose()
          terminal.dispose()
        }
      )
      const textarea = terminal.terminal.textarea
      if (textarea === undefined) {
        return yield* new ConnectTerminalSetupError({
          cause: "Ghostty Web did not create the terminal input",
          detail: "Ghostty Web terminal input unavailable"
        })
      }
      applyTerminalInputIdentity(textarea)
      const releaseTerminalFocus = keyboard.setTerminalFocus(textarea, () => focusTerminalInput(textarea))
      yield* Effect.addFinalizer(() => Effect.sync(releaseTerminalFocus))
      let ready = false
      let socket: WebSocket | null = null
      let inputOverflow = false
      const outputBoundary = makeTerminalOutputBoundary()
      let pendingResize: {
        readonly cols: number
        readonly rows: number
      } | null = null
      const pendingInput = makePendingTerminalInput()
      const send = (command: TerminalClientCommand): boolean => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(command))
          return true
        }
        return false
      }
      const sendInput = (text: string): boolean => send({ type: "terminal.input", text })
      const releaseInputSender = keyboard.setInputSender((command) => send(command))
      yield* Effect.addFinalizer(() => Effect.sync(releaseInputSender))
      const releasePaste = keyboard.setPaste((text) => terminal.terminal.paste(text))
      yield* Effect.addFinalizer(() => Effect.sync(releasePaste))
      const releaseCursorModeReader = keyboard.setCursorModeReader(() =>
        terminal.terminal.getMode(1) ? "application" : "normal"
      )
      yield* Effect.addFinalizer(() => Effect.sync(releaseCursorModeReader))
      const applyInput = (text: string): Extract<TerminalInputApplication, { readonly _tag: "supported" }> | null => {
        const application = applyTerminalModifierToInput(keyboard.getModifier(), text)
        if (application._tag === "unsupported") {
          keyboard.reportError(application)
          return null
        }
        return application
      }
      const input = terminal.terminal.onData(
        makeTerminalInputHandler({
          applyInput,
          isReady: () => ready,
          onFailure: (failure) => {
            if (failure === "input_queue_overflow") {
              inputOverflow = true
              update({
                _tag: "failed",
                agent,
                detail: "terminal input queue exceeded 64 KiB before ready"
              })
              socket?.close(4429, "terminal input queue limit reached")
              return
            }
            update({ _tag: "failed", agent, detail: "terminal input could not be sent" })
            socket?.close(4429, "terminal input unavailable")
          },
          outputBoundary,
          pendingInput,
          sendInput,
          setModifier: keyboard.setModifier
        })
      )
      const resize = terminal.terminal.onResize(({ cols, rows }) => {
        if (!ready) {
          pendingResize = { cols, rows }
          return
        }
        send(terminalResizeCommand({ cols, rows }))
      })
      const interaction = bindTerminalInteraction(
        terminal.terminal,
        container,
        (command) => ready && send(command),
        keyboard.interactionView
      )
      const releaseInteraction = keyboard.setInteraction(interaction)
      terminal.terminal.attachCustomWheelEventHandler((event) => interaction.handleWheel(event))
      terminal.terminal.attachCustomKeyEventHandler((event) => {
        if (event.type === "keydown" && (event.key === "PageUp" || event.key === "PageDown")) {
          interaction.pageScroll(event.key === "PageUp" ? "up" : "down")
          return true
        }
        return interaction.handleKey(event)
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          pendingInput.clear()
          input.dispose()
          resize.dispose()
          releaseInteraction()
          interaction.dispose()
        })
      )
      const connectedSocket = yield* Effect.acquireRelease(
        Effect.callback<WebSocket, ConnectNetworkError>((resume) => {
          const value = new WebSocket(
            socketUrl(agent, { cols: terminal.terminal.cols, rows: terminal.terminal.rows }, takeover)
          )
          value.binaryType = "arraybuffer"
          let settled = false
          value.addEventListener("open", () => {
            if (settled) return
            settled = true
            resume(Effect.succeed(value))
          })
          value.addEventListener("error", () => {
            if (settled) return
            settled = true
            resume(
              Effect.fail(
                new ConnectNetworkError({
                  detail: "terminal WebSocket failed to open"
                })
              )
            )
          })
          return Effect.sync(() => value.close())
        }),
        (value) => Effect.sync(() => value.close(1000, "view detached"))
      )
      socket = connectedSocket
      if (inputOverflow) {
        return yield* new ConnectInputQueueError({
          detail: "terminal input queue exceeded 64 KiB before ready"
        })
      }
      yield* Effect.callback<void, ConnectNetworkError>((resume) => {
        const message = (event: MessageEvent<ArrayBuffer | string>): void => {
          const binary = Schema.decodeUnknownResult(Schema.instanceOf(ArrayBuffer))(event.data)
          if (Result.isSuccess(binary)) {
            renderTerminalOutput(terminal.terminal, new Uint8Array(binary.success), outputBoundary, (error) => {
              update({ _tag: "failed", agent, detail: error.detail })
              connectedSocket.close(4400, "terminal output could not be rendered")
            })
            interaction.frameArrived(new Uint8Array(binary.success))
            return
          }
          const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(TerminalServerSignal))(event.data)
          if (Result.isFailure(decoded)) {
            update({
              _tag: "failed",
              agent,
              detail: `invalid terminal server message: ${String(decoded.failure)}`
            })
            connectedSocket.close(4400, "invalid terminal server message")
            return
          }
          if (decoded.success.type === "terminal.scroll_state") {
            interaction.serverScrollState(decoded.success.offsetFromBottom, decoded.success.scrollsForwarded)
            return
          }
          if (decoded.success.type === "terminal.ready") {
            ready = true
            const queued = pendingInput.drain()
            if (queued.length > 0) {
              if (!sendInput(queued)) {
                update({ _tag: "failed", agent, detail: "terminal input could not be sent" })
                connectedSocket.close(4429, "terminal input unavailable")
                return
              }
            }
            if (pendingResize !== null) {
              send(terminalResizeCommand(pendingResize))
              pendingResize = null
            }
            update({ _tag: "connected", agent })
          }
        }
        const close = (event: CloseEvent): void => {
          ready = false
          pendingInput.clear()
          update(terminalConnectionAfterClose(agent, event))
          resume(Effect.void)
        }
        connectedSocket.addEventListener("message", message)
        connectedSocket.addEventListener("close", close, { once: true })
        return Effect.sync(() => {
          connectedSocket.removeEventListener("message", message)
          connectedSocket.removeEventListener("close", close)
        })
      })
    }).pipe(Effect.catch((error) => Effect.sync(() => update({ _tag: "failed", agent, detail: error.detail }))))
  )

type ConnectSurfaceProps = {
  /** Hides portal presentation and stage presence while retaining selection, polls and terminal ownership. */
  readonly active?: boolean
  readonly atoms: ConnectAtoms
  /** Absent uses standalone browser history. Present owns URL and navigation together; url is never mutated. */
  readonly directoryLocation?: ConnectDirectoryLocation | undefined
  readonly embedded?: boolean
  readonly presentation?:
    | { readonly _tag: "fleet" }
    | {
        readonly _tag: "home"
        readonly summary?: ReactNode
        readonly empty?: ReactNode
        /** Replaces the list, its filters and the archive switch: the host has nothing Connect can list. */
        readonly unavailable?: ReactNode
      }
  readonly roomFooter?: ReactNode
  /** Optional host observer for the live stage; archive stages never report a live identity. */
  readonly onStageChange?: (target: Pick<ConnectAgent, "host" | "id"> | null) => void
  /** Optional application controls inside the open live stage; absent by default. */
  readonly stageFooter?: ReactNode
}

/**
 * Fleet is the default directory presentation, with URL-owned Active/Archived selection.
 * Home accepts host-owned summary and empty content. Both retain the same reads, selection,
 * stage, pins and terminal lifetime; inactive portal presentation hides without dropping owners.
 */
export const ConnectSurface = (props: ConnectSurfaceProps) => {
  // Inventory reads also drive archive observation while the live directory is not shown.
  useAtomMount(props.atoms.agentsPoll)
  const directoryLocation = useConnectDirectoryLocation(props.directoryLocation)
  return directoryLocation.url.searchParams.get("view") === "archived" ? (
    <ConnectArchiveSurface
      atoms={props.atoms}
      embedded={props.embedded ?? false}
      directoryLocation={directoryLocation}
      active={props.active ?? true}
      presentation={props.presentation?._tag ?? "fleet"}
      roomFooter={props.roomFooter}
    />
  ) : (
    <ActiveConnectSurface {...props} directoryLocation={directoryLocation} />
  )
}

const ActiveConnectSurface = ({
  active = true,
  atoms,
  directoryLocation,
  embedded = false,
  onStageChange,
  presentation = { _tag: "fleet" },
  roomFooter,
  stageFooter
}: ConnectSurfaceProps & { readonly directoryLocation: ConnectDirectoryLocation }) => {
  const locationSearch = directoryLocation.url.search
  const activeRef = useRef(active)
  useLayoutEffect(() => {
    activeRef.current = active
  }, [active])
  const fleetPresentation = presentation._tag === "fleet"
  const homeUnavailable = presentation._tag === "home" ? presentation.unavailable : undefined
  const DirectoryView = fleetPresentation ? AgentDirectory : ConnectHomeDirectory
  const [activityFilter, setActivityFilter] = useAtom(atoms.activityFilter)
  const directory = useAtomValue(atoms.agents)
  const refreshDirectory = useAtomRefresh(atoms.agents)
  const remembered = useAtomValue(atoms.preference)
  const [connection, setConnection] = useAtom(atoms.connection)
  const [connectionRequest, setConnectionRequest] = useAtom(atoms.connectionRequest)
  const [terminalEntry, setTerminalEntry] = useState<{ readonly enter: () => void } | null>(null)
  const [hostFilter, setHostFilter] = useAtom(atoms.hostFilter)
  const [preferenceError, setPreferenceError] = useAtom(atoms.preferenceError)
  const [query, setQuery] = useAtom(atoms.query)
  const [selectedKey, setSelectedKey] = useAtom(atoms.selectedKey)
  const work = useAtomValue(atoms.work)
  const preferenceApplied = useRef(false)
  const preferenceSelection = useRef(connectTargetSelection(locationSearch))
  const requestId = useRef(connectionRequest?.id ?? 0)
  const directorySearchRef = useRef<HTMLInputElement>(null)
  const directoryViewportRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const [shellElement, setShellElement] = useState<HTMLDivElement | null>(null)
  const terminalActiveRequestRef = useRef<number | null>(null)
  const terminalEntryLockRef = useRef<(() => void) | null>(null)
  const terminalBackRef = useRef<HTMLButtonElement>(null)
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalFocusTargetRef = useRef<HTMLElement>(null)
  const terminalViewportRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const terminalInputRef = useRef<(command: TerminalInputCommand) => boolean>(() => false)
  const terminalInputOwnerRef = useRef<symbol | null>(null)
  const terminalFocusRef = useRef<() => void>(() => {})
  const terminalCursorModeReaderRef = useRef<() => TerminalCursorMode>(() => "normal")
  const terminalCursorModeOwnerRef = useRef<symbol | null>(null)
  const terminalModifierRef = useRef<TerminalModifiers>(noTerminalModifiers)
  const [terminalModifier, setTerminalModifier] = useState<TerminalModifiers>(noTerminalModifiers)
  const [terminalKeyError, setTerminalKeyError] = useState<string | null>(null)
  // Follows the terminal input's real focus, so the Keyboard button matches what iOS shows.
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const terminalPasteRef = useRef<((text: string) => void) | null>(null)
  const pasteClipboard = (): void => {
    const paste = terminalPasteRef.current
    if (paste === null) return
    Effect.runFork(
      startClipboardRead().pipe(
        Effect.tap((text) =>
          Effect.sync(() => {
            if (text === "") {
              setTerminalKeyError("Nothing to paste: the clipboard has no text.")
              return
            }
            // A latched Ctrl or Alt would be applied to the pasted text; pasting releases it.
            terminalModifierRef.current = noTerminalModifiers
            setTerminalModifier(noTerminalModifiers)
            setTerminalKeyError(null)
            paste(text)
          })
        ),
        Effect.catch((error) =>
          Effect.sync(() =>
            setTerminalKeyError(
              error.reason === "unavailable" ? "Paste isn't available in this browser." : "Paste was not allowed."
            )
          )
        )
      )
    )
  }
  // Synchronous inside the button's click: iOS raises its keyboard only within the gesture.
  const toggleKeyboard = (open: boolean): void => {
    const target = terminalFocusTargetRef.current
    if (target === null) return
    if (open) terminalFocusRef.current()
    else target.blur()
  }
  // The stored choice seeds it; this session's toggle wins once made. Unreadable storage shows the keys.
  const storedKeysHidden = useAtomValue(atoms.terminalKeysHidden)
  const [keysHiddenChoice, setKeysHiddenChoice] = useState<boolean | null>(null)
  const terminalKeysHidden =
    keysHiddenChoice ?? (AsyncResult.isSuccess(storedKeysHidden) ? storedKeysHidden.value : false)
  const changeTerminalKeysHidden = (hidden: boolean): void => {
    setKeysHiddenChoice(hidden)
    // A latched Ctrl or Alt would stay applied with no visible indicator or way to cancel it, so a
    // plain "c" would arrive as Ctrl-C. Hiding the keys releases it.
    if (hidden) {
      terminalModifierRef.current = noTerminalModifiers
      setTerminalModifier(noTerminalModifiers)
    }
    Effect.runFork(
      storeTerminalKeysHidden(hidden).pipe(
        Effect.catch(() =>
          Effect.sync(() => setTerminalKeyError("Couldn't remember this on this device; it applies until you reload."))
        )
      )
    )
  }
  const terminalInteractionRef = useRef<TerminalInteraction | null>(null)
  const [terminalLinesBack, setTerminalLinesBack] = useState(0)
  const [terminalPositionUnconfirmed, setTerminalPositionUnconfirmed] = useState(false)
  const [terminalTextLines, setTerminalTextLines] = useState<ReadonlyArray<string> | null>(null)
  const [workspaceFocusFailure, setWorkspaceFocusFailure] = useState<ConnectWorkspaceFocusFailureReason | null>(null)

  const copyTerminalText = useCallback((text: string): void => {
    navigator.clipboard.writeText(text).then(
      () => setTerminalKeyError(null),
      () => setTerminalKeyError("Copy was blocked by the browser.")
    )
  }, [])

  const releaseTerminalEntryLock = useCallback((): void => {
    const release = terminalEntryLockRef.current
    terminalEntryLockRef.current = null
    release?.()
  }, [])

  const attachShell = useCallback((element: HTMLDivElement | null): void => {
    shellRef.current = element
    setShellElement(element)
  }, [])

  const workspaceElements = (): ConnectWorkspaceElements | null => {
    const directoryScreen = directoryViewportRef.current
    const terminalScreen = terminalViewportRef.current
    const workspace = workspaceRef.current
    return directoryScreen === null || terminalScreen === null || workspace === null
      ? null
      : { directory: directoryScreen, terminal: terminalScreen, workspace }
  }

  const directoryFocusTarget = (agent: ConnectAgent): HTMLElement | null => {
    const directoryScreen = directoryViewportRef.current
    if (directoryScreen === null) return null
    const key = connectAgentKey(agent)
    return (
      [...directoryScreen.querySelectorAll<HTMLButtonElement>(".connect-agent:not(:disabled)")].find(
        (button) => button.dataset.agentKey === key
      ) ??
      directorySearchRef.current ??
      directoryScreen
    )
  }

  const restoreDirectoryFocus = (agent: ConnectAgent): ConnectWorkspaceFocusTransition => {
    const elements = workspaceElements()
    const focusTarget = directoryFocusTarget(agent)
    if (elements !== null && focusTarget !== null) return returnToDirectoryWorkspace(elements, focusTarget)
    const terminalScreen = terminalViewportRef.current
    const activeElement = Schema.decodeUnknownResult(Schema.instanceOf(HTMLElement))(window.document.activeElement)
    if (terminalScreen !== null && Result.isSuccess(activeElement) && terminalScreen.contains(activeElement.success)) {
      activeElement.success.blur()
    }
    return { _tag: "failed", reason: "detached_element" }
  }

  useEffect(() => {
    const container = terminalRef.current
    if (connectionRequest === null || container === null) return
    const terminalRequestId = connectionRequest.id
    const workerGuard = makeTerminalWorkerGuard(terminalRequestId)
    const releaseTerminalFocus = (): void => {
      workerGuard.release()
      terminalFocusRef.current = () => {}
      terminalFocusTargetRef.current = null
      terminalActiveRequestRef.current = null
    }
    const invalidateTerminalRequest = (): void => {
      if (requestId.current === terminalRequestId) requestId.current += 1
      setConnectionRequest(null)
    }
    const applyTerminalState = (state: ConnectionState): void => {
      if (!workerGuard.accepts(requestId.current)) return
      if (state._tag === "connected" && !activeRef.current) {
        // A retained worker can connect off-screen; only its visible owner may move focus or lock the document.
        terminalActiveRequestRef.current = terminalRequestId
      } else if (state._tag === "connected") {
        const elements = workspaceElements()
        const focusTarget = window.matchMedia("(pointer: fine)").matches
          ? terminalFocusTargetRef.current
          : terminalBackRef.current
        if (elements === null || focusTarget === null) {
          releaseTerminalFocus()
          invalidateTerminalRequest()
          setConnection({
            _tag: "failed",
            agent: state.agent,
            entryFocusFailure: "detached_element",
            detail: fleetPresentation
              ? "terminal focus transition failed: detached_element"
              : connectWorkspaceFocusFailureMessage("detached_element")
          })
          return
        }
        releaseTerminalEntryLock()
        const lockedTransition = enterTerminalWorkspaceWithLock(elements, focusTarget, () =>
          bindTerminalDocumentLock(window)
        )
        terminalEntryLockRef.current = lockedTransition.releaseLock
        const transition = lockedTransition.transition
        if (transition._tag === "failed") {
          releaseTerminalEntryLock()
          releaseTerminalFocus()
          invalidateTerminalRequest()
          setConnection({
            _tag: "failed",
            agent: state.agent,
            entryFocusFailure: transition.reason,
            detail: fleetPresentation
              ? `terminal focus transition failed: ${transition.reason}`
              : connectWorkspaceFocusFailureMessage(transition.reason)
          })
          return
        }
        setWorkspaceFocusFailure(null)
        terminalActiveRequestRef.current = terminalRequestId
      } else if (state._tag === "controlled" || state._tag === "taken-over") {
        releaseTerminalEntryLock()
        releaseTerminalFocus()
        invalidateTerminalRequest()
        terminalActiveRequestRef.current = null
        setStageKey(connectAgentKey(state.agent))
      } else if (state._tag === "closed" || state._tag === "failed") {
        if (activeRef.current && terminalActiveRequestRef.current === terminalRequestId) {
          const transition = restoreDirectoryFocus(state.agent)
          if (transition._tag === "failed") {
            setWorkspaceFocusFailure(transition.reason)
          } else {
            setWorkspaceFocusFailure(null)
          }
          terminalActiveRequestRef.current = null
        }
        invalidateTerminalRequest()
      }
      setConnection(state)
    }
    const fiber = Effect.runFork(
      terminalWorker(
        container,
        connectionRequest.agent,
        (state) => {
          if (!workerGuard.accepts(requestId.current)) return
          if (state._tag === "connected" && connectionRequest.retainStage === true) {
            setStageKey(null)
            // Enter after the stage's modal cleanup, so its isolation cannot reject terminal focus.
            setTerminalEntry({ enter: () => applyTerminalState(state) })
          } else {
            applyTerminalState(state)
          }
        },
        {
          getModifier: () => terminalModifierRef.current,
          setTerminalFocus: (target, focus) => {
            terminalFocusTargetRef.current = target
            terminalFocusRef.current = focus
            setKeyboardOpen(target.ownerDocument.activeElement === target)
            const releaseFocusTracking = trackTerminalInputFocus(target, setKeyboardOpen)
            return () => {
              releaseFocusTracking()
              if (terminalFocusRef.current === focus) terminalFocusRef.current = () => {}
              if (terminalFocusTargetRef.current === target) {
                terminalFocusTargetRef.current = null
                setKeyboardOpen(false)
              }
            }
          },
          reportError: () => setTerminalKeyError("That modifier combination is not supported."),
          setInputSender: (sendInput) => {
            const owner = Symbol("terminal-input-sender")
            terminalInputOwnerRef.current = owner
            terminalInputRef.current = sendInput
            return () => {
              if (terminalInputOwnerRef.current !== owner) return
              terminalInputOwnerRef.current = null
              terminalInputRef.current = () => false
            }
          },
          setPaste: (paste) => {
            terminalPasteRef.current = paste
            return () => {
              if (terminalPasteRef.current === paste) terminalPasteRef.current = null
            }
          },
          setCursorModeReader: (read) => {
            const owner = Symbol("terminal-cursor-mode-reader")
            terminalCursorModeOwnerRef.current = owner
            terminalCursorModeReaderRef.current = read
            return () => {
              if (terminalCursorModeOwnerRef.current !== owner) return
              terminalCursorModeOwnerRef.current = null
              terminalCursorModeReaderRef.current = () => "normal"
            }
          },
          setModifier: (modifier) => {
            terminalModifierRef.current = modifier
            setTerminalModifier((current) => (current === modifier ? current : modifier))
            setTerminalKeyError(null)
          },
          interactionView: {
            onLinesBack: setTerminalLinesBack,
            onPositionUnconfirmed: setTerminalPositionUnconfirmed,
            onSelectText: setTerminalTextLines,
            openUrl: (url) => {
              window.open(url, "_blank", "noopener,noreferrer")
            },
            copy: copyTerminalText,
            focusKeyboard: () => terminalFocusRef.current()
          },
          setInteraction: (interaction) => {
            terminalInteractionRef.current = interaction
            return () => {
              if (terminalInteractionRef.current !== interaction) return
              terminalInteractionRef.current = null
              setTerminalLinesBack(0)
              setTerminalPositionUnconfirmed(false)
              setTerminalTextLines(null)
            }
          }
        },
        connectionRequest.takeover === true
      )
    )
    return () => {
      releaseTerminalEntryLock()
      workerGuard.release()
      Effect.runFork(Fiber.interrupt(fiber))
      container.replaceChildren()
    }
  }, [connectionRequest, copyTerminalText, releaseTerminalEntryLock, setConnection])

  useEffect(() => {
    if (terminalEntry === null) return
    setTerminalEntry(null)
    terminalEntry.enter()
  }, [terminalEntry])

  // Worker cleanup above relinquishes callbacks before this owner clears its shared terminal state.
  // Inactivity does not run this cleanup: hidden modules keep their socket and selected agent.
  useEffect(
    () => () => {
      setConnectionRequest(null)
      setConnection((current) =>
        current._tag === "connected" || current._tag === "connecting" ? { _tag: "idle" } : current
      )
    },
    [setConnection, setConnectionRequest]
  )

  const terminalVisible = connection._tag === "connected" || workspaceFocusFailure === "focus_rejected"
  const terminalViewportActive = terminalViewportBindingActive({
    connectionRequested: connectionRequest !== null,
    focusRejected: workspaceFocusFailure === "focus_rejected",
    terminalConnected: connection._tag === "connected"
  })

  // Size the hidden terminal before its first visible frame so Fleet navigation never overlaps it.
  useLayoutEffect(() => {
    const room = terminalViewportRef.current
    if (!active) {
      releaseTerminalEntryLock()
      return
    }
    if (!terminalViewportActive || room === null) return
    const attachedShell = shellElement ?? shellRef.current
    const topBoundary = embedded ? attachedShell : undefined
    if (topBoundary === null) return
    try {
      return bindTerminalViewport(room, window, topBoundary, terminalVisible)
    } finally {
      if (terminalVisible) releaseTerminalEntryLock()
    }
  }, [active, embedded, releaseTerminalEntryLock, shellElement, terminalViewportActive, terminalVisible])

  const previouslyActive = useRef(active)
  // Only activation may restore terminal focus. Other panels and editors retain their own focus authority.
  useEffect(() => {
    const returning = active && !previouslyActive.current
    previouslyActive.current = active
    if (!returning || connection._tag !== "connected") return
    const focused = document.activeElement
    if (
      focused !== null &&
      focused.closest('[role="dialog"], [role="alertdialog"], input, textarea, select, [contenteditable="true"]') !==
        null
    )
      return
    const elements = workspaceElements()
    const target = window.matchMedia("(pointer: fine)").matches
      ? terminalFocusTargetRef.current
      : terminalBackRef.current
    if (elements === null || target === null) return
    const entry = enterTerminalWorkspaceWithLock(elements, target, () => bindTerminalDocumentLock(window))
    entry.releaseLock()
    setWorkspaceFocusFailure(entry.transition._tag === "failed" ? entry.transition.reason : null)
  }, [active, connection._tag])

  const current = AsyncResult.isSuccess(directory)
    ? directory.value
    : directory._tag === "Failure" && directory.previousSuccess._tag === "Some"
      ? directory.previousSuccess.value.value
      : null
  const lastAgents = useRef<ReadonlyArray<ConnectAgent>>([])
  const missingHosts = new Set((current?.failures ?? []).map(({ host }) => host))
  const retainedAgents = lastAgents.current.filter((agent) => missingHosts.has(agent.host))
  const agents = [
    ...(current?.agents ?? []),
    ...retainedAgents.filter(
      (old) => !(current?.agents ?? []).some((agent) => connectAgentKey(agent) === connectAgentKey(old))
    )
  ]
  useEffect(() => {
    if (current !== null) lastAgents.current = agents
  }, [current])
  // A failed refresh keeps the last good list; say how old it is rather than presenting it as live.
  const staleSince =
    directory._tag === "Failure" && directory.previousSuccess._tag === "Some"
      ? directory.previousSuccess.value.timestamp
      : null
  const offlineHosts = (current?.failures ?? []).map((failure) => failure.host)
  const answeringHosts = (current?.hosts ?? []).filter(
    (host) => !offlineHosts.some((offline) => offline.toLowerCase() === host.toLowerCase())
  )
  const silentHosts = silentHostsSentence(
    current?.failures ?? [],
    retainedAgents.map(({ host }) => host)
  )
  // The directory's own read time: it changes only when a poll lands, so nothing ticks between reads.
  const updatedAt = AsyncResult.isSuccess(directory) ? directory.timestamp : staleSince
  const refreshingTimestamp =
    !fleetPresentation && directory._tag === "Success" && directory.waiting ? directory.timestamp : null
  const [refreshNoticeDeadline, setRefreshNoticeDeadline] = useState<number | null>(null)
  useEffect(() => {
    if (refreshingTimestamp === null) {
      setRefreshNoticeDeadline(null)
      return
    }
    // One UI deadline, not another read loop. A held request must cross the threshold without unrelated renders.
    const timeout = window.setTimeout(
      () => setRefreshNoticeDeadline(refreshingTimestamp),
      Math.max(0, 10_000 - (Date.now() - refreshingTimestamp))
    )
    return () => window.clearTimeout(timeout)
  }, [refreshingTimestamp])
  const refreshAge = refreshingTimestamp === null ? 0 : Math.max(0, Date.now() - refreshingTimestamp)
  const refreshingOldReading =
    refreshingTimestamp !== null && (refreshAge >= 10_000 || refreshNoticeDeadline === refreshingTimestamp)
  const refreshAgeText =
    refreshAge < 60_000
      ? `${String(Math.floor(refreshAge / 1_000))} sec`
      : `${String(Math.floor(refreshAge / 60_000))} min`
  const selected =
    agents.find((agent) => connectAgentKey(agent) === selectedKey) ??
    (connectionRequest !== null && connectAgentKey(connectionRequest.agent) === selectedKey
      ? connectionRequest.agent
      : null)
  const currentWork = workSnapshotForAssociation(work)
  const workGoalResolution: ConnectWorkGoalResolution =
    selected === null
      ? { _tag: "unavailable", reason: "snapshot_unavailable" }
      : currentWork === null
        ? { _tag: "unavailable", reason: "snapshot_unavailable" }
        : resolveConnectWorkGoal(selected, currentWork)
  // The agent whose stage is open: a row or the cast opens it, Open terminal leaves it for the terminal.
  const [stageKey, setStageKey] = useState<string | null>(null)
  const stageUrlSelection = useRef<{ readonly key: string; readonly selection: ConnectTargetSelection } | null>(null)
  const stageReturnKey = useRef<string | null>(null)
  const restoreStageFocus = useCallback(() => {
    const key = stageReturnKey.current
    stageReturnKey.current = null
    if (key === null) return undefined
    const row = activeRef.current
      ? shellRef.current?.querySelector<HTMLButtonElement>(`.connect-agent[data-agent-key="${CSS.escape(key)}"]`)
      : undefined
    if (
      row !== undefined &&
      row !== null &&
      row.isConnected &&
      row.closest('[hidden], [inert], [aria-hidden="true"]') === null &&
      row.getClientRects().length > 0
    )
      return row
    return shellRef.current?.closest<HTMLElement>("main") ?? undefined
  }, [])
  const openLocalStage = (agent: ConnectAgent): void => {
    stageReturnKey.current = null
    stageUrlSelection.current = null
    setStageKey(connectAgentKey(agent))
  }
  const stageCandidate =
    stageKey === null ? null : (agents.find((agent) => connectAgentKey(agent) === stageKey) ?? null)
  const stageAgent =
    stageCandidate === null || connectAgentIdentityAmbiguous(agents, stageCandidate) ? null : stageCandidate
  const stageHost = stageAgent?.host ?? null
  const stageId = stageAgent?.id ?? null
  const stageChange = useRef(onStageChange)
  useLayoutEffect(() => {
    stageChange.current = onStageChange
  }, [onStageChange])
  useEffect(() => {
    stageChange.current?.(!active || stageHost === null || stageId === null ? null : { host: stageHost, id: stageId })
    return () => stageChange.current?.(null)
  }, [active, stageHost, stageId])
  // An agent that leaves the directory closes its stage for good: it must not reopen, uninvited, when the
  // agent comes back on a later poll. Only a loaded list counts; a list still loading keeps the stage.
  useEffect(() => {
    if (stageKey !== null && stageAgent === null && current !== null) {
      stageReturnKey.current = stageUrlSelection.current?.key ?? null
      stageUrlSelection.current = null
      setStageKey(null)
    }
  }, [current, stageAgent, stageKey])
  // Who started needing you since the last poll; the first list a surface sees is history, not news.
  const previousBuckets = useRef<AgentBuckets | null>(null)
  const [arrivals, setArrivals] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (current === null) return
    const buckets = agentBucketsOf(current.agents, presentation._tag)
    setArrivals(arrivalsBetween(previousBuckets.current, buckets))
    // A host that missed this poll keeps what it last reported, so its waiting agents don't arrive again.
    const silent = new Set(current.failures.map((failure) => failure.host))
    previousBuckets.current = nextAgentBuckets(previousBuckets.current, buckets, silent)
  }, [current, presentation._tag])
  // The stored pins seed them; this session's choices win once made. Unreadable storage pins nothing.
  const storedPins = useAtomValue(atoms.pinned)
  const [pinsChoice, setPinsChoice] = useState<Pins | null>(null)
  // Unpinning the last one is a choice too: only "no choice yet" falls back to what was stored.
  const pins: Pins = pinsChoice ?? (AsyncResult.isSuccess(storedPins) ? storedPins.value : [])
  const [pinError, setPinError] = useState<string | null>(null)
  const savePins = (next: Pins): void => {
    setPinsChoice(next)
    Effect.runFork(
      storePins(next).pipe(
        Effect.catch(() =>
          Effect.sync(() => setPinError("Couldn't remember the pins on this device; they apply until you reload."))
        )
      )
    )
  }
  // Retained rows explain a silent host; pins treat only this poll's agents as present.
  const agentByKey = new Map(
    (current?.agents ?? [])
      .filter((agent) => !connectAgentIdentityAmbiguous(current?.agents ?? [], agent))
      .map((agent) => [connectAgentKey(agent), agent])
  )
  const pinnable = (agent: ConnectAgent) => ({
    host: agent.host,
    id: String(agent.id),
    key: connectAgentKey(agent),
    name: agent.name,
    hue: agent.hue
  })
  const changePin = (agent: ConnectAgent, pinned: boolean): void => {
    setPinError(null)
    if (!pinned) {
      savePins(unpin(pins, connectAgentKey(agent)))
      return
    }
    Result.match(pin(pins, pinnable(agent), Date.now()), {
      onFailure: (refused) =>
        setPinError(`You can pin up to ${String(refused.limit)} agents. Unpin one to pin ${agent.name}.`),
      onSuccess: savePins
    })
  }
  const removePin = (key: string): void => {
    setPinError(null)
    savePins(unpin(pins, key))
  }
  // Each poll records only agents it listed, excluding retained silent-host rows, so an away pin can say when
  // it was last seen. Only a new poll observes; the pins it reads are the latest, through a ref, so a pin
  // change doesn't re-run it.
  const pinsNow = useRef(pins)
  pinsNow.current = pins
  const observeRef = useRef(savePins)
  observeRef.current = savePins
  useEffect(() => {
    if (current === null) return
    const observed = observePins(
      pinsNow.current,
      current.agents.map((agent) => ({
        host: agent.host,
        id: String(agent.id),
        key: connectAgentKey(agent),
        name: agent.name,
        hue: agent.hue
      })),
      Date.now()
    )
    if (observed !== pinsNow.current) observeRef.current(observed)
  }, [current])
  const floatPins = arrangePins(
    pins,
    (key) => agentByKey.get(key),
    PIN_ROOM.float,
    (key) => key === stageKey
  )
  const floatRows = floatPins.shown.length + (floatPins.overflow.length > 0 ? 1 : 0)
  // A phone's terminal bar has no room for chips beside the name: there the pins sit behind one button, so the
  // bar never takes a second line from the terminal.
  const narrow = useNarrowScreen()
  const barRoom = narrow ? 0 : PIN_ROOM.bar
  const barPins = arrangePins(
    pins,
    (key) => agentByKey.get(key),
    barRoom,
    (key) => key === selectedKey
  )
  const barPinned = barPins.shown.length + barPins.overflow.length > 0
  const pinRows: CSSProperties & Record<"--connect-pin-rows", string> = { "--connect-pin-rows": String(floatRows) }
  const stageCrew =
    stageAgent === null
      ? []
      : agents.filter((agent) => agent.host === stageAgent.host && agent.relationship?.parentAgentId === stageAgent.id)
  const selectAgent = (agent: ConnectAgent, takeover = false, retainStage = false): void => {
    if (connectAgentIdentityAmbiguous(agents, agent)) return
    preferenceApplied.current = true
    const key = connectAgentKey(agent)
    terminalInputOwnerRef.current = null
    terminalInputRef.current = () => false
    terminalFocusRef.current = () => {}
    terminalFocusTargetRef.current = null
    terminalCursorModeOwnerRef.current = null
    terminalCursorModeReaderRef.current = () => "normal"
    terminalModifierRef.current = noTerminalModifiers
    terminalActiveRequestRef.current = null
    setTerminalModifier(noTerminalModifiers)
    setTerminalKeyError(null)
    setWorkspaceFocusFailure(null)
    setSelectedKey(key)
    setConnection({ _tag: "connecting", agent })
    requestId.current += 1
    setConnectionRequest({ agent, id: requestId.current, takeover, retainStage })
    Effect.runFork(
      storeRememberedAgent(key).pipe(
        Effect.tap(() => Effect.sync(() => setPreferenceError(null))),
        Effect.catch((error) => Effect.sync(() => setPreferenceError(error.operation)))
      )
    )
  }
  useEffect(() => {
    const selection = connectTargetSelection(locationSearch)
    if (!sameConnectTargetSelection(preferenceSelection.current, selection)) {
      preferenceSelection.current = selection
      preferenceApplied.current = false
      const owned = stageUrlSelection.current
      if (owned !== null && !sameConnectTargetSelection(selection, owned.selection)) {
        stageReturnKey.current = owned.key
        stageUrlSelection.current = null
        setStageKey(null)
      }
    }
    if (preferenceApplied.current || current === null) return
    const stored: RememberedConnectPreference = AsyncResult.isSuccess(remembered)
      ? { _tag: "available", key: remembered.value }
      : { _tag: "unavailable" }
    const fiber = Effect.runFork(
      resolveConnectPreferenceDecision(locationSearch, current.agents, stored).pipe(
        Effect.tap((decision) =>
          Effect.sync(() => {
            if (decision._tag === "retry") {
              setSelectedKey(decision.key)
              setPreferenceError(decision.error)
              return
            }
            preferenceApplied.current = true
            if (decision._tag === "select") {
              setSelectedKey(decision.key)
              setPreferenceError(decision.error)
            } else if (decision._tag === "stage") {
              const key = connectAgentKey(decision.target)
              stageReturnKey.current = null
              stageUrlSelection.current = { key, selection }
              setStageKey(key)
            } else {
              selectAgent(decision.target)
            }
          })
        )
      )
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [current, remembered, locationSearch, setPreferenceError, setSelectedKey])
  const moveAgentFocus = (event: KeyboardEvent<HTMLElement>): void => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".connect-agent:not(:disabled)")]
    const currentIndex = buttons.findIndex((button) => button === event.target)
    if (currentIndex < 0) return
    const nextIndex = nextConnectAgentIndex(event.key, currentIndex, buttons.length)
    if (nextIndex === null) return
    const next = buttons.at(nextIndex)
    if (next === undefined) return
    event.preventDefault()
    next.focus()
  }

  const disconnect = (): void => {
    let nextConnection: ConnectionState = { _tag: "idle" }
    let nextFocusFailure: ConnectWorkspaceFocusFailureReason | null = null
    if (connection._tag !== "idle" && (connection._tag === "connected" || workspaceFocusFailure === "focus_rejected")) {
      const transition = restoreDirectoryFocus(connection.agent)
      if (transition._tag === "failed") {
        nextConnection = {
          _tag: "failed",
          agent: connection.agent,
          detail: fleetPresentation
            ? `terminal focus transition failed: ${transition.reason}`
            : connectWorkspaceFocusFailureMessage(transition.reason)
        }
        nextFocusFailure = transition.reason
      }
    }
    requestId.current += 1
    terminalActiveRequestRef.current = null
    setConnection(nextConnection)
    setConnectionRequest(null)
    terminalInputOwnerRef.current = null
    terminalInputRef.current = () => false
    terminalFocusRef.current = () => {}
    terminalFocusTargetRef.current = null
    terminalCursorModeOwnerRef.current = null
    terminalCursorModeReaderRef.current = () => "normal"
    terminalModifierRef.current = noTerminalModifiers
    setTerminalModifier(noTerminalModifiers)
    setTerminalKeyError(null)
    setWorkspaceFocusFailure(nextFocusFailure)
  }

  const changeTerminalModifier = (modifier: TerminalModifier): void => {
    const next = toggleTerminalModifier(terminalModifierRef.current, modifier)
    terminalModifierRef.current = next
    setTerminalModifier(next)
    setTerminalKeyError(null)
  }

  const sendTerminalRailKey = (key: TerminalRailKey): void => {
    const dispatch = dispatchTerminalKey(key, terminalModifierRef.current, terminalCursorModeReaderRef.current())
    if (dispatch._tag === "unsupported") {
      setTerminalKeyError("That modifier combination is not supported.")
      return
    }
    if (!terminalInputRef.current(dispatch.command)) {
      setTerminalKeyError("Terminal connection is unavailable.")
      return
    }
    terminalModifierRef.current = dispatch.nextModifier
    setTerminalModifier(dispatch.nextModifier)
    setTerminalKeyError(null)
  }

  const firstLoadFailure = directory._tag === "Failure" ? Cause.squash(directory.cause) : null
  const firstLoadTimedOut = Schema.is(ConnectTimeoutError)(firstLoadFailure)
  const firstLoadUnreachable = Schema.is(ConnectNetworkError)(firstLoadFailure)
  const firstLoadStatus = Schema.is(ConnectStatusError)(firstLoadFailure) ? firstLoadFailure.status : null

  const directoryScreen = (
    <>
      {fleetPresentation ? (
        <div className="connect-directory-heading">
          <header
            className={
              embedded ? "connect-embedded-intro connect-directory-title" : "connect-header connect-directory-title"
            }
          >
            <Text as="h1" variant="card-title">
              Connect
              {current === null ? null : <ConnectSummary agents={agents} unavailable={false} />}
            </Text>
            {current === null ? <ConnectSummary agents={null} unavailable={directory._tag === "Failure"} /> : null}
            {updatedAt === null ? null : (
              <small className="connect-updated" data-stale={staleSince === null ? undefined : "true"}>
                {staleSince === null ? "Updated " : "Stale, last updated "}
                <time dateTime={new Date(updatedAt).toISOString()}>
                  {new Date(updatedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit"
                  })}
                </time>
              </small>
            )}
          </header>
          <ConnectDirectorySwitch location={directoryLocation} />
        </div>
      ) : (
        <div className="connect-home-heading">
          <header className="connect-home-intro">
            <Text as="h1" variant="card-title">
              Connect
            </Text>
            <Text as="p" tone="secondary">
              {connectHomePurpose}
            </Text>
          </header>
          {homeUnavailable === undefined ? <ConnectDirectorySwitch home location={directoryLocation} /> : null}
        </div>
      )}
      {fleetPresentation ||
      staleSince === null ||
      (presentation._tag === "home" && presentation.empty !== undefined) ? null : (
        <div className="connect-home-read-notice" role="status">
          <div>
            <StateLabel icon="clock" label="Couldn’t refresh" tone="caution" size="compact" />
            <span>
              Previous reading{" "}
              <time dateTime={new Date(staleSince).toISOString()}>
                {new Date(staleSince).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
              </time>
              . Retrying every 5 seconds.
            </span>
          </div>
        </div>
      )}
      {!refreshingOldReading ? null : (
        <div className="connect-home-read-notice" role="status">
          <div>
            <StateLabel icon="loader" label="Refreshing" tone="progress" size="compact" />
            <span>Updated {refreshAgeText} ago. The last reading stays on screen until the refresh lands.</span>
          </div>
        </div>
      )}
      {fleetPresentation ||
      current === null ||
      offlineHosts.length === 0 ||
      staleSince !== null ||
      homeUnavailable !== undefined ? null : (
        <div className="connect-home-read-notice" role="status">
          <div>
            <StateLabel
              icon="clock"
              label={`${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(offlineHosts)} didn’t answer`}
              tone="caution"
              size="compact"
            />
            <span>
              {offlineHosts.length === 1 ? "Its agents show as Unknown." : "Their agents show as Unknown."}{" "}
              {answeringHosts.length === 0
                ? null
                : `${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(answeringHosts)} ${answeringHosts.length === 1 ? "is" : "are"} live.`}
            </span>
          </div>
          <Button
            className="connect-home-retry connect-home-tap"
            onClick={refreshDirectory}
            size="compact"
            variant="secondary"
          >
            Retry
          </Button>
        </div>
      )}
      {presentation._tag === "home" && presentation.summary !== undefined ? (
        <div className="connect-home-summary">{presentation.summary}</div>
      ) : null}
      <section
        aria-label="Herdr agents"
        className="connect-agents"
        data-loading={current === null ? "true" : undefined}
        onKeyDown={moveAgentFocus}
        style={pinRows}
      >
        {fleetPresentation || connection._tag !== "failed" || connection.entryFocusFailure === undefined ? null : (
          <div className="connect-home-failure" role="alert">
            <StateLabel
              icon="alert"
              label={`Couldn’t open ${connection.agent.name}’s terminal`}
              tone="caution"
              size="compact"
            />
            <span>{connectWorkspaceFocusFailureMessage(connection.entryFocusFailure)}</span>
          </div>
        )}
        {staleSince === null || directory._tag !== "Failure" || !fleetPresentation ? null : (
          <small className="connect-status-message" data-tone="caution">
            The list is stale. Couldn't refresh the directory: {causeSummary(directory.cause)}. Showing the list from{" "}
            {new Date(staleSince).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}; retrying every 5
            seconds.
          </small>
        )}
        {silentHosts === null || !fleetPresentation ? null : (
          <p className="connect-failures" role="status">
            {silentHosts}
          </p>
        )}
        {current === null ? (
          directory._tag === "Failure" ? (
            <div className="connect-empty connect-directory-error" data-unreachable={firstLoadUnreachable || undefined}>
              <Icon decorative name="alert" size="default" />
              <div className="connect-directory-error-copy">
                <Text as="h2" variant="card-title">
                  {firstLoadTimedOut
                    ? "The fleet directory didn't answer"
                    : firstLoadUnreachable
                      ? "Couldn’t load the fleet directory"
                      : "Couldn't load the fleet directory"}
                </Text>
                {firstLoadTimedOut ? (
                  <Text as="p" tone="secondary">
                    The request timed out, so no agents are listed. Retry, or wait: Relay tries again every 5 seconds.
                  </Text>
                ) : firstLoadUnreachable ? (
                  <Text as="p" tone="secondary">
                    Relay couldn’t reach the hub. It tries again every 5 seconds.
                  </Text>
                ) : firstLoadStatus === null ? null : (
                  <Text as="p" tone="secondary">
                    The hub answered HTTP {String(firstLoadStatus)}.
                  </Text>
                )}
                <Button
                  className={firstLoadTimedOut ? "connect-compact-secondary" : undefined}
                  onClick={refreshDirectory}
                  size={firstLoadTimedOut ? "dense" : "default"}
                  variant="secondary"
                >
                  Retry
                </Button>
              </div>
            </div>
          ) : (
            <Text className="connect-loading-copy" tone="secondary">
              Loading fleet agents…
            </Text>
          )
        ) : homeUnavailable !== undefined ? (
          homeUnavailable
        ) : (
          <>
            {fleetPresentation ? (
              <AgentCast
                agents={agents}
                arrivals={arrivals}
                onOpen={openLocalStage}
                silentHosts={offlineHosts}
                stale={staleSince !== null}
              />
            ) : null}
            <DirectoryView
              search={
                <label className="connect-search">
                  <span>Find agent</span>
                  <Icon decorative name="search" size="small" />
                  <input
                    autoComplete="off"
                    id="connect-agent-search"
                    name="agent-search"
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault()
                        setQuery("")
                        event.currentTarget.blur()
                        return
                      }
                      if (event.key !== "ArrowDown") return
                      const firstAgent = event.currentTarget
                        .closest(".connect-agents")
                        ?.querySelector<HTMLButtonElement>(".connect-agent:not(:disabled)")
                      if (firstAgent === undefined || firstAgent === null) return
                      event.preventDefault()
                      firstAgent.focus()
                    }}
                    placeholder="Name, host, state…"
                    ref={directorySearchRef}
                    type="search"
                    value={query}
                  />
                  {embedded ? (
                    <kbd aria-hidden="true" className="connect-search-shortcut">
                      Ctrl K
                    </kbd>
                  ) : null}
                </label>
              }
              onClearQuery={() => {
                setQuery("")
                const search = directorySearchRef.current
                if (search !== null && search.closest('[hidden], [inert], [aria-hidden="true"]') === null)
                  search.focus()
              }}
              activityFilter={activityFilter}
              agents={agents}
              configuredHosts={current.hosts ?? []}
              empty={presentation._tag === "home" ? presentation.empty : undefined}
              hostFilter={hostFilter}
              onActivityFilter={setActivityFilter}
              onHostFilter={setHostFilter}
              onSelect={openLocalStage}
              query={query}
              selectedKey={stageKey}
              arrivals={arrivals}
              silentHosts={offlineHosts}
              stale={staleSince !== null}
            />
            <AgentStage
              footer={stageFooter}
              agent={active ? stageAgent : null}
              presentation={presentation._tag}
              terminalControl={
                stageAgent !== null &&
                connection._tag !== "idle" &&
                connectAgentKey(stageAgent) === connectAgentKey(connection.agent) &&
                (connection._tag === "controlled" ||
                  connection._tag === "taken-over" ||
                  (connection._tag === "connecting" && connectionRequest?.retainStage === true))
                  ? {
                      state: connection._tag,
                      onAction: () => selectAgent(stageAgent, connection._tag === "controlled", true)
                    }
                  : undefined
              }
              restoreFocus={restoreStageFocus}
              agents={agents}
              workSnapshots={currentWork}
              crew={stageCrew}
              onClose={() => {
                const closing = stageKey
                if (connection._tag === "connecting" && connectionRequest?.retainStage === true) disconnect()
                stageUrlSelection.current = null
                setStageKey(null)
                const url = directoryLocation?.url
                const fromUrl =
                  stageAgent !== null &&
                  connectTargetSelectionMatches(connectTargetSelection(locationSearch), stageAgent, "stage")
                stageReturnKey.current = fromUrl ? closing : null
                if (fromUrl) {
                  directoryLocation.navigate(connectDirectoryHref("active", undefined, url), "replace")
                  return
                }
                // The control that opened the stage may be gone (the pin hides while its stage is open, the
                // terminal's bar chip unmounts on the way here); focus then goes to the agent's row, not the page.
                window.setTimeout(() => {
                  if (
                    !activeRef.current ||
                    closing === null ||
                    (document.activeElement !== null && document.activeElement !== document.body)
                  )
                    return
                  const target =
                    document.querySelector<HTMLButtonElement>(
                      `.connect-agent[data-agent-key="${CSS.escape(closing)}"]`
                    ) ?? directorySearchRef.current
                  target?.focus()
                }, 0)
              }}
              onOpen={openLocalStage}
              onPinChange={(pinned) => (stageAgent === null ? undefined : changePin(stageAgent, pinned))}
              pinned={stageKey !== null && pins.some((each) => each.key === stageKey)}
              workGoal={
                stageAgent === null || currentWork === null
                  ? { _tag: "unavailable", reason: "snapshot_unavailable" }
                  : resolveConnectWorkGoal(stageAgent, currentWork)
              }
              onOpenTerminal={(agent) => {
                stageUrlSelection.current = null
                setStageKey(null)
                selectAgent(agent)
              }}
              stale={staleSince !== null || (stageAgent !== null && offlineHosts.includes(stageAgent.host))}
            />
            {pinError === null ? null : (
              <small className="connect-status-message" data-tone="caution" role="status">
                {pinError}
              </small>
            )}
          </>
        )}
        {connection._tag === "connecting" ? (
          <small className="connect-status-message">Connecting to {connection.agent.name}…</small>
        ) : connection._tag === "failed" && (fleetPresentation || connection.entryFocusFailure === undefined) ? (
          <small className="connect-status-message" data-tone="critical" role="alert">
            {connection.agent.name}: {connection.detail}
          </small>
        ) : connection._tag === "closed" ? (
          <small className="connect-status-message">{connection.agent.name} disconnected.</small>
        ) : null}
        {remembered._tag === "Failure" ? (
          <small className="connect-preference-error">
            Selection memory unavailable: {causeSummary(remembered.cause)}
          </small>
        ) : preferenceError === null ? null : (
          <small className="connect-preference-error">Selection memory unavailable: {preferenceError}</small>
        )}
        {workspaceFocusFailure === null || workspaceFocusFailure === "focus_rejected" ? null : (
          <small className="connect-status-message" data-tone="critical">
            {fleetPresentation
              ? `Terminal focus transition failed: ${workspaceFocusFailure}`
              : connectWorkspaceFocusFailureMessage(workspaceFocusFailure)}
          </small>
        )}
        {current === null && directory._tag !== "Failure" ? (
          <div aria-hidden="true" className="connect-loading-skeletons">
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index} />
            ))}
          </div>
        ) : null}
        {!fleetPresentation || current === null ? null : (
          <div className="connect-directory-secondary" data-pinned={floatRows > 0 ? "" : undefined}>
            <ConnectLimitsOwner atoms={atoms} />
            {embedded ? null : (
              <nav className="fleet-app-nav" aria-label="Fleet applications">
                <a href="/">Approvals</a>
                <a href="/connect/" aria-current="page">
                  Connect
                </a>
              </nav>
            )}
          </div>
        )}
        {current === null ? null : (
          <PinnedAgents
            agentFor={(key) => agentByKey.get(key)}
            hiddenKey={stageKey}
            now={Date.now()}
            onOpen={openLocalStage}
            onUnpin={removePin}
            pins={pins}
            placement="float"
            stale={staleSince !== null}
          />
        )}
      </section>
    </>
  )

  const terminalScreen = (
    <Surface as="section" padding="none" className="terminal-stage">
      {/* Pins take a column of their own, set here rather than with :has(), which Firefox 120 lacks. */}
      <div className="terminal-bar" data-pinned={barPinned ? "" : undefined}>
        <button className="terminal-back" onClick={disconnect} ref={terminalBackRef} type="button">
          Agents
        </button>
        <div>
          {selected === null ? (
            <strong>Agent</strong>
          ) : (
            <ConnectAgentIdentity agent={selected} resolution={workGoalResolution} />
          )}
          <small>{selected === null ? "Herdr terminal" : `${selected.kind} on ${selected.host}`}</small>
        </div>
        <StateLabel
          label={
            connection._tag === "connected"
              ? "connected"
              : connection._tag === "closed"
                ? "disconnected"
                : "unavailable"
          }
          tone={connection._tag === "connected" ? "positive" : connection._tag === "failed" ? "critical" : "neutral"}
          size="compact"
        />
        {/* In the terminal the pins sit in this bar, never over the output or the key rail. */}
        <PinnedAgents
          agentFor={(key) => agentByKey.get(key)}
          hiddenKey={selectedKey}
          now={Date.now()}
          onOpen={(agent) => {
            disconnect()
            openLocalStage(agent)
          }}
          onUnpin={removePin}
          pins={pins}
          placement="bar"
          room={barRoom}
          stale={staleSince !== null}
        />
      </div>
      {workspaceFocusFailure === "focus_rejected" ? (
        <small className="connect-status-message" data-tone="critical" role="alert">
          {fleetPresentation
            ? `Terminal focus transition failed: ${workspaceFocusFailure}`
            : connectWorkspaceFocusFailureMessage(workspaceFocusFailure)}
        </small>
      ) : null}
      <TerminalKeyRail
        disabled={connection._tag !== "connected"}
        error={terminalKeyError}
        modifier={terminalModifier}
        keyboardOpen={keyboardOpen}
        keysHidden={terminalKeysHidden}
        onFocusTerminal={() => terminalFocusRef.current()}
        onKey={sendTerminalRailKey}
        onKeyboardToggle={toggleKeyboard}
        onPaste={pasteClipboard}
        onKeysHiddenChange={changeTerminalKeysHidden}
        onModifierChange={changeTerminalModifier}
        onSelectText={() => terminalInteractionRef.current?.selectText()}
        onJumpToLatest={() => terminalInteractionRef.current?.jumpToLatest()}
        linesBack={terminalLinesBack}
        positionUnconfirmed={terminalPositionUnconfirmed}
      />
      <div className="terminal-viewport-stage">
        <div
          aria-label={selected === null ? "Agent terminal" : `${selected.name} terminal`}
          className="ghostty-terminal"
          ref={terminalRef}
        />
        {terminalTextLines === null ? null : (
          <TerminalTextLayer
            lines={terminalTextLines}
            onCopy={copyTerminalText}
            onDone={() => setTerminalTextLines(null)}
          />
        )}
      </div>
    </Surface>
  )

  return (
    <div
      className={embedded ? "connect-shell connect-shell-embedded" : "connect-shell"}
      data-connect-presentation={fleetPresentation ? undefined : "home"}
      ref={attachShell}
      tabIndex={-1}
    >
      <WorkPollMount atom={atoms.workPoll} />
      <ConnectWorkspace
        directory={directoryScreen}
        directoryViewportRef={directoryViewportRef}
        mode={terminalVisible ? "terminal" : "directory"}
        terminal={terminalScreen}
        terminalViewportRef={terminalViewportRef}
        workspaceRef={workspaceRef}
      />
      {roomFooter}
    </div>
  )
}
