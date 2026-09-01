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
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react"
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
import { AgentDirectory, connectAgentKey, ConnectWorkspace, type AgentActivityFilter } from "./view.js"
import { acquireTerminalSetup, ConnectTerminalSetupError } from "./terminal-setup.js"
import { terminalBackground } from "./terminal-theme.js"
import { bindTerminalViewport } from "./terminal-viewport.js"
import { type RememberedConnectPreference, resolveConnectPreferenceDecision } from "./target.js"
import { nextConnectAgentIndex } from "./keyboard.js"

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

const browserRuntime = Atom.runtime(BrowserHttpClient.layerFetch)

export const makeConnectAtoms = () => {
  const agents = browserRuntime.atom(loadAgents)
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
    selectedKey: Atom.make<string | null>(null)
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

const terminalWorker = (container: HTMLElement, agent: ConnectAgent, update: (state: ConnectionState) => void) =>
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
          const input = value.textarea
          if (input === undefined) {
            throw new ConnectTerminalSetupError({
              cause: "Ghostty Web did not create the terminal input",
              detail: "Ghostty Web terminal input unavailable"
            })
          }
          applyTerminalInputIdentity(input)
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
      let ready = false
      let socket: WebSocket | null = null
      let inputOverflow = false
      let pendingResize: {
        readonly cols: number
        readonly rows: number
      } | null = null
      const pendingInput = makePendingTerminalInput()
      const send = (command: TerminalClientCommand): void => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(command))
        }
      }
      const input = terminal.terminal.onData((text) => {
        if (ready) {
          send({ type: "terminal.input", text })
        } else if (pendingInput.push(text) === "overflow") {
          inputOverflow = true
          update({
            _tag: "failed",
            agent,
            detail: "terminal input queue exceeded 64 KiB before ready"
          })
          socket?.close(4429, "terminal input queue limit reached")
        }
      })
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
            terminal.terminal.write(new Uint8Array(binary.success))
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
              send({ type: "terminal.input", text: queued })
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
            if (window.matchMedia("(pointer: fine)").matches) {
              terminal.terminal.focus()
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
  const preferenceApplied = useRef(false)
  const requestId = useRef(0)
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalViewportRef = useRef<HTMLDivElement>(null)
  useAtomMount(atoms.agentsPoll)

  useEffect(() => {
    const container = terminalRef.current
    if (connectionRequest === null || container === null) return
    const fiber = Effect.runFork(terminalWorker(container, connectionRequest.agent, setConnection))
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
      container.replaceChildren()
    }
  }, [connectionRequest, setConnection])

  const terminalConnected = connection._tag === "connected"
  useEffect(() => {
    const room = terminalViewportRef.current
    if (!terminalConnected || room === null) return
    return bindTerminalViewport(room, window)
  }, [terminalConnected])

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
  const selectAgent = (agent: ConnectAgent): void => {
    preferenceApplied.current = true
    const key = connectAgentKey(agent)
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
    setConnectionRequest(null)
    setConnection({ _tag: "idle" })
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
        <button className="terminal-back" onClick={disconnect} type="button">
          Agents
        </button>
        <div>
          <strong>{selected?.name ?? "Agent"}</strong>
          <small>{selected === null ? "Herdr terminal" : `${selected.host} · ${selected.kind}`}</small>
        </div>
        <StateLabel label="connected" tone="positive" size="compact" />
      </div>
      <div
        aria-label={selected === null ? "Agent terminal" : `${selected.name} terminal`}
        className="ghostty-terminal"
        ref={terminalRef}
      />
    </Surface>
  )

  return (
    <div className={embedded ? "connect-shell connect-shell-embedded" : "connect-shell"}>
      <ConnectWorkspace
        directory={directoryScreen}
        mode={connection._tag === "connected" ? "terminal" : "directory"}
        terminal={terminalScreen}
        terminalViewportRef={terminalViewportRef}
      />
      {roomFooter}
    </div>
  )
}
