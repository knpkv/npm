import { useAtom, useAtomMount, useAtomValue } from "@effect/atom-react"
import { BrowserHttpClient } from "@effect/platform-browser"
import { StateLabel, Surface, Text } from "@knpkv/rly/primitives"
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { Cause, Effect, Fiber, Result, Schedule, Schema } from "effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { FitAddon, init, Terminal } from "ghostty-web"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { buildConnectForest } from "./forest.js"
import { applyTerminalInputIdentity } from "./terminal-input-identity.js"
import {
  type ConnectAgent,
  type ConnectAgentCursor,
  FleetConnectAgentPage,
  FleetConnectAgents,
  type TerminalClientCommand,
  TerminalServerSignal
} from "./model.js"
import {
  makePendingTerminalInput,
  makeTouchScrollGesture,
  pageScrollCommand,
  wheelScrollCommand
} from "./terminal-input.js"
import {
  makeTerminalInputHandler,
  makeTerminalOutputBoundary,
  type TerminalOutputBoundary,
  writeTerminalOutput
} from "./terminal-output.js"
import { AgentDirectory, connectAgentKey, ConnectWorkspace, TerminalKeyRail, type AgentActivityFilter } from "./view.js"
import { acquireTerminalSetup, ConnectTerminalSetupError } from "./terminal-setup.js"
import { terminalBackground } from "./terminal-theme.js"
import { bindTerminalViewport } from "./terminal-viewport.js"
import { type RememberedConnectPreference, resolveConnectPreferenceDecision } from "./target.js"
import { nextConnectAgentIndex } from "./keyboard.js"
import {
  applyTerminalModifierToInput,
  dispatchTerminalKey,
  toggleTerminalModifier,
  type TerminalInputApplication,
  type TerminalCursorMode,
  type TerminalModifier,
  type TerminalRailKey
} from "./terminal-keyboard.js"
import { WorkSnapshots } from "@knpkv/herdr-work/model"
import { ConnectAgentIdentity } from "./work-goal-link-view.js"
import { resolveConnectWorkGoal, workSnapshotForAssociation, type ConnectWorkGoalResolution } from "./work-goal-link.js"
import { WorkPollMount } from "./work-poll.js"
import { makeTerminalWorkerGuard } from "./terminal-worker-guard.js"
import {
  enterTerminalWorkspace,
  returnToDirectoryWorkspace,
  type ConnectWorkspaceElements,
  type ConnectWorkspaceFocusFailureReason,
  type ConnectWorkspaceFocusTransition
} from "./workspace-focus.js"

class ConnectNetworkError extends Schema.TaggedError<ConnectNetworkError>()("ConnectNetworkError", {
  detail: Schema.String
}) {}

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

class ConnectInputQueueError extends Schema.TaggedError<ConnectInputQueueError>()("ConnectInputQueueError", {
  detail: Schema.String
}) {}

type ConnectionState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "connecting"; readonly agent: ConnectAgent }
  | { readonly _tag: "connected"; readonly agent: ConnectAgent }
  | { readonly _tag: "closed"; readonly agent: ConnectAgent }
  | {
      readonly _tag: "failed"
      readonly agent: ConnectAgent
      readonly detail: string
    }

type ConnectionRequest = {
  readonly agent: ConnectAgent
  readonly id: number
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

const loadAgents = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const agents: Array<ConnectAgent> = []
  const failures: Array<(typeof FleetConnectAgents.Type)["failures"][number]> = []
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
    cursor = page.nextCursor
  } while (cursor !== null)
  const directory = yield* Schema.decodeUnknownEffect(FleetConnectAgents)({ agents, failures }).pipe(
    Effect.mapError(
      (cause) =>
        new ConnectProtocolError({
          detail: "invalid fleet agent directory",
          cause
        })
    )
  )
  yield* buildConnectForest(directory.agents).pipe(
    Effect.mapError(
      (cause) =>
        new ConnectProtocolError({
          detail: "invalid fleet agent relationship forest",
          cause
        })
    )
  )
  return directory
})

const loadWork = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const response = yield* client
    .get("/v1/work")
    .pipe(Effect.mapError((cause) => new ConnectNetworkError({ detail: String(cause) })))
  if (response.status < 200 || response.status >= 300) {
    return yield* new ConnectStatusError({ status: response.status })
  }
  return yield* decodeBoundedResponseJson(response, WorkSnapshots).pipe(
    Effect.mapError(
      (cause) =>
        new ConnectProtocolError({
          detail: "invalid Work snapshot",
          cause
        })
    )
  )
})

const browserRuntime = Atom.runtime(BrowserHttpClient.layerFetch)

export const makeConnectAtoms = () => {
  const agents = browserRuntime.atom(loadAgents)
  const work = browserRuntime.atom(loadWork)
  return {
    activityFilter: Atom.make<AgentActivityFilter>("all"),
    agents,
    agentsPoll: browserRuntime.atom(Atom.refresh(agents).pipe(Effect.repeat(Schedule.spaced("5 seconds")))),
    connection: Atom.make<ConnectionState>({ _tag: "idle" }),
    connectionRequest: Atom.make<ConnectionRequest | null>(null),
    hostFilter: Atom.make<string | null>(null),
    preference: Atom.make(loadRememberedAgent),
    preferenceError: Atom.make<string | null>(null),
    query: Atom.make(""),
    selectedKey: Atom.make<string | null>(null),
    work,
    workPoll: browserRuntime.atom(Atom.refresh(work).pipe(Effect.repeat(Schedule.spaced("5 seconds"))))
  }
}

export type ConnectAtoms = ReturnType<typeof makeConnectAtoms>

const socketUrl = (agent: ConnectAgent, cols: number, rows: number): string => {
  const url = new URL("/v1/connect/session", window.location.href)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("host", agent.host)
  url.searchParams.set("agent", agent.id)
  url.searchParams.set("cols", String(cols))
  url.searchParams.set("rows", String(rows))
  return url.toString()
}

type TerminalInputCommand = Extract<TerminalClientCommand, { readonly type: "terminal.input" }>

type TerminalKeyboardCallbacks = {
  readonly getModifier: () => TerminalModifier | null
  readonly setModifier: (modifier: TerminalModifier | null) => void
  readonly setTerminalFocus: (target: HTMLElement, focus: () => void) => () => void
  readonly reportError: (error: TerminalInputApplication) => void
  readonly setInputSender: (sendInput: (command: TerminalInputCommand) => boolean) => () => void
  readonly setCursorModeReader: (read: () => TerminalCursorMode) => () => void
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
  keyboard: TerminalKeyboardCallbacks
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
              foreground: "#e7e9ec",
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
      const releaseTerminalFocus = keyboard.setTerminalFocus(textarea, () => terminal.terminal.focus())
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
        send({
          type: "terminal.resize",
          cols,
          rows,
          cell_width_px: 0,
          cell_height_px: 0
        })
      })
      terminal.terminal.attachCustomWheelEventHandler((event) => {
        const command = wheelScrollCommand(event, terminal.terminal.rows)
        if (command === null) return false
        if (ready) send(command)
        return true
      })
      terminal.terminal.attachCustomKeyEventHandler((event) => {
        const command = pageScrollCommand(event.key, terminal.terminal.rows)
        if (command === null) return false
        if (ready) send(command)
        return true
      })
      const touchGesture = makeTouchScrollGesture({
        blur: () => terminal.terminal.blur(),
        rows: () => terminal.terminal.rows,
        send: (command) => {
          if (ready) send(command)
        }
      })
      const touchStart = (event: TouchEvent): void => {
        if (event.touches.length !== 1) {
          touchGesture.cancel()
          return
        }
        const touch = event.touches.item(0)
        if (touch === null) return
        touchGesture.start(touch.clientY)
      }
      const touchMove = (event: TouchEvent): void => {
        const touch = event.touches.item(0)
        if (touch !== null && touchGesture.move(touch.clientY)) {
          event.preventDefault()
        }
      }
      const touchEnd = (event: TouchEvent): void => {
        if (touchGesture.end()) event.preventDefault()
      }
      const touchCancel = (): void => touchGesture.cancel()
      container.addEventListener("touchstart", touchStart, { passive: true })
      container.addEventListener("touchmove", touchMove, { passive: false })
      container.addEventListener("touchend", touchEnd, { passive: false })
      container.addEventListener("touchcancel", touchCancel)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          pendingInput.clear()
          input.dispose()
          resize.dispose()
          container.removeEventListener("touchstart", touchStart)
          container.removeEventListener("touchmove", touchMove)
          container.removeEventListener("touchend", touchEnd)
          container.removeEventListener("touchcancel", touchCancel)
        })
      )
      const connectedSocket = yield* Effect.acquireRelease(
        Effect.callback<WebSocket, ConnectNetworkError>((resume) => {
          const value = new WebSocket(socketUrl(agent, terminal.terminal.cols, terminal.terminal.rows))
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
              send({
                type: "terminal.resize",
                cols: pendingResize.cols,
                rows: pendingResize.rows,
                cell_width_px: 0,
                cell_height_px: 0
              })
              pendingResize = null
            }
            update({ _tag: "connected", agent })
          }
        }
        const close = (event: CloseEvent): void => {
          update(
            event.code === 1000
              ? { _tag: "closed", agent }
              : {
                  _tag: "failed",
                  agent,
                  detail: event.reason || `connection closed (${event.code})`
                }
          )
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

export const ConnectSurface = ({
  atoms,
  embedded = false,
  roomFooter
}: {
  readonly atoms: ConnectAtoms
  readonly embedded?: boolean
  readonly roomFooter?: ReactNode
}) => {
  const [activityFilter, setActivityFilter] = useAtom(atoms.activityFilter)
  const directory = useAtomValue(atoms.agents)
  const remembered = useAtomValue(atoms.preference)
  const [connection, setConnection] = useAtom(atoms.connection)
  const [connectionRequest, setConnectionRequest] = useAtom(atoms.connectionRequest)
  const [hostFilter, setHostFilter] = useAtom(atoms.hostFilter)
  const [preferenceError, setPreferenceError] = useAtom(atoms.preferenceError)
  const [query, setQuery] = useAtom(atoms.query)
  const [selectedKey, setSelectedKey] = useAtom(atoms.selectedKey)
  const work = useAtomValue(atoms.work)
  const preferenceApplied = useRef(false)
  const requestId = useRef(connectionRequest?.id ?? 0)
  const directorySearchRef = useRef<HTMLInputElement>(null)
  const directoryViewportRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const [shellElement, setShellElement] = useState<HTMLDivElement | null>(null)
  const terminalActiveRequestRef = useRef<number | null>(null)
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
  const terminalModifierRef = useRef<TerminalModifier | null>(null)
  const [terminalModifier, setTerminalModifier] = useState<TerminalModifier | null>(null)
  const [terminalKeyError, setTerminalKeyError] = useState<string | null>(null)
  const [workspaceFocusFailure, setWorkspaceFocusFailure] = useState<ConnectWorkspaceFocusFailureReason | null>(null)
  useAtomMount(atoms.agentsPoll)

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
      [...directoryScreen.querySelectorAll<HTMLButtonElement>(".connect-agent")].find(
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
    const fiber = Effect.runFork(
      terminalWorker(
        container,
        connectionRequest.agent,
        (state) => {
          if (!workerGuard.accepts(requestId.current)) return
          if (state._tag === "connected") {
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
                detail: "terminal focus transition failed: detached_element"
              })
              return
            }
            const transition = enterTerminalWorkspace(elements, focusTarget)
            if (transition._tag === "failed") {
              releaseTerminalFocus()
              invalidateTerminalRequest()
              setConnection({
                _tag: "failed",
                agent: state.agent,
                detail: `terminal focus transition failed: ${transition.reason}`
              })
              return
            }
            setWorkspaceFocusFailure(null)
            terminalActiveRequestRef.current = terminalRequestId
          } else if (state._tag === "closed" || state._tag === "failed") {
            if (terminalActiveRequestRef.current === terminalRequestId) {
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
        },
        {
          getModifier: () => terminalModifierRef.current,
          setTerminalFocus: (target, focus) => {
            terminalFocusTargetRef.current = target
            terminalFocusRef.current = focus
            return () => {
              if (terminalFocusRef.current === focus) terminalFocusRef.current = () => {}
              if (terminalFocusTargetRef.current === target) terminalFocusTargetRef.current = null
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
          }
        }
      )
    )
    return () => {
      workerGuard.release()
      Effect.runFork(Fiber.interrupt(fiber))
      container.replaceChildren()
    }
  }, [connectionRequest, setConnection])

  // Size the hidden terminal before its first visible frame so Fleet navigation never overlaps it.
  useLayoutEffect(() => {
    const room = terminalViewportRef.current
    if (connectionRequest === null || room === null) return
    if (embedded && shellElement === null && shellRef.current === null) return
    const topBoundary = embedded ? (shellElement ?? shellRef.current) : undefined
    if (topBoundary === null) return
    return bindTerminalViewport(room, window, topBoundary)
  }, [connectionRequest, embedded, shellElement])

  const current = AsyncResult.isSuccess(directory)
    ? directory.value
    : directory._tag === "Failure" && directory.previousSuccess._tag === "Some"
      ? directory.previousSuccess.value.value
      : null
  const agents = current?.agents ?? []
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
  const selectAgent = (agent: ConnectAgent): void => {
    preferenceApplied.current = true
    const key = connectAgentKey(agent)
    terminalInputOwnerRef.current = null
    terminalInputRef.current = () => false
    terminalFocusRef.current = () => {}
    terminalFocusTargetRef.current = null
    terminalCursorModeOwnerRef.current = null
    terminalCursorModeReaderRef.current = () => "normal"
    terminalModifierRef.current = null
    terminalActiveRequestRef.current = null
    setTerminalModifier(null)
    setTerminalKeyError(null)
    setWorkspaceFocusFailure(null)
    setSelectedKey(key)
    setConnection({ _tag: "connecting", agent })
    requestId.current += 1
    setConnectionRequest({ agent, id: requestId.current })
    Effect.runFork(
      storeRememberedAgent(key).pipe(
        Effect.tap(() => Effect.sync(() => setPreferenceError(null))),
        Effect.catch((error) => Effect.sync(() => setPreferenceError(error.operation)))
      )
    )
  }
  useEffect(() => {
    if (preferenceApplied.current || current === null) return
    const stored: RememberedConnectPreference = AsyncResult.isSuccess(remembered)
      ? { _tag: "available", key: remembered.value }
      : { _tag: "unavailable" }
    const fiber = Effect.runFork(
      resolveConnectPreferenceDecision(window.location.search, current.agents, stored).pipe(
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
  }, [current, remembered, setPreferenceError, setSelectedKey])
  const moveAgentFocus = (event: KeyboardEvent<HTMLElement>): void => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".connect-agent")]
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
          detail: `terminal focus transition failed: ${transition.reason}`
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
    terminalModifierRef.current = null
    setTerminalModifier(null)
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

  const directoryScreen = (
    <>
      {embedded ? (
        <header className="connect-embedded-intro">
          <div>
            <Text variant="meta" tone="secondary">
              Live fleet directory
            </Text>
            <Text as="h1" variant="page-title">
              Connect to an agent
            </Text>
            <Text tone="secondary">Choose a worker, reviewer, or coordinator to open its exact terminal.</Text>
          </div>
          <StateLabel
            label={current === null ? "Loading" : `${String(agents.length)} agents`}
            size="compact"
            tone={current === null ? "neutral" : "positive"}
          />
        </header>
      ) : (
        <header className="connect-header">
          <div>
            <Text variant="meta" tone="secondary">
              Herdr fleet
            </Text>
            <Text as="h1" variant="page-title">
              Connect
            </Text>
          </div>
          <nav className="fleet-app-nav" aria-label="Fleet applications">
            <a href="/">Approvals</a>
            <a href="/connect/" aria-current="page">
              Connect
            </a>
          </nav>
        </header>
      )}
      <section className="connect-agents" aria-label="Herdr agents" onKeyDown={moveAgentFocus}>
        <label className="connect-search">
          <span>Find agent</span>
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
                ?.querySelector<HTMLButtonElement>(".connect-agent")
              if (firstAgent === undefined || firstAgent === null) return
              event.preventDefault()
              firstAgent.focus()
            }}
            placeholder="Name, host, state…"
            ref={directorySearchRef}
            type="search"
            value={query}
          />
        </label>
        {current === null ? (
          <Text tone="secondary">
            {directory._tag === "Failure" ? Cause.pretty(directory.cause) : "Loading fleet agents…"}
          </Text>
        ) : agents.length === 0 ? (
          <Text tone="secondary">No live agents.</Text>
        ) : (
          <AgentDirectory
            activityFilter={activityFilter}
            agents={agents}
            hostFilter={hostFilter}
            onActivityFilter={setActivityFilter}
            onHostFilter={setHostFilter}
            onSelect={selectAgent}
            query={query}
            selectedKey={selectedKey}
          />
        )}
        {connection._tag === "connecting" ? (
          <small className="connect-status-message">Connecting to {connection.agent.name}…</small>
        ) : connection._tag === "failed" ? (
          <small className="connect-status-message" data-tone="critical">
            {connection.agent.name} · {connection.detail}
          </small>
        ) : connection._tag === "closed" ? (
          <small className="connect-status-message">{connection.agent.name} disconnected.</small>
        ) : null}
        {remembered._tag === "Failure" ? (
          <small className="connect-preference-error">
            Selection memory unavailable · {Cause.pretty(remembered.cause)}
          </small>
        ) : preferenceError === null ? null : (
          <small className="connect-preference-error">Selection memory unavailable · {preferenceError}</small>
        )}
        {workspaceFocusFailure === null || workspaceFocusFailure === "focus_rejected" ? null : (
          <small className="connect-status-message" data-tone="critical">
            Terminal focus transition failed · {workspaceFocusFailure}
          </small>
        )}
        {(current?.failures.length ?? 0) === 0 ? null : (
          <div className="connect-failures">
            {current?.failures.map((failure) => (
              <small key={failure.host}>
                {failure.host} · {failure.reason.replaceAll("_", " ")}
              </small>
            ))}
          </div>
        )}
      </section>
    </>
  )

  const terminalScreen = (
    <Surface as="section" padding="none" className="terminal-stage">
      <div className="terminal-bar">
        <button className="terminal-back" onClick={disconnect} ref={terminalBackRef} type="button">
          Agents
        </button>
        <div>
          {selected === null ? (
            <strong>Agent</strong>
          ) : (
            <ConnectAgentIdentity agent={selected} resolution={workGoalResolution} />
          )}
          <small>{selected === null ? "Herdr terminal" : `${selected.host} · ${selected.kind}`}</small>
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
      </div>
      {workspaceFocusFailure === "focus_rejected" ? (
        <small className="connect-status-message" data-tone="critical" role="alert">
          Terminal focus transition failed · {workspaceFocusFailure}
        </small>
      ) : null}
      <TerminalKeyRail
        disabled={connection._tag !== "connected"}
        error={terminalKeyError}
        modifier={terminalModifier}
        onFocusTerminal={() => terminalFocusRef.current()}
        onKey={sendTerminalRailKey}
        onModifierChange={changeTerminalModifier}
      />
      <div
        aria-label={selected === null ? "Agent terminal" : `${selected.name} terminal`}
        className="ghostty-terminal"
        ref={terminalRef}
      />
    </Surface>
  )

  return (
    <div
      className={embedded ? "connect-shell connect-shell-embedded" : "connect-shell"}
      ref={attachShell}
      tabIndex={-1}
    >
      <WorkPollMount atom={atoms.workPoll} />
      <ConnectWorkspace
        directory={directoryScreen}
        directoryViewportRef={directoryViewportRef}
        mode={connection._tag === "connected" || workspaceFocusFailure === "focus_rejected" ? "terminal" : "directory"}
        terminal={terminalScreen}
        terminalViewportRef={terminalViewportRef}
        workspaceRef={workspaceRef}
      />
      {roomFooter}
    </div>
  )
}
