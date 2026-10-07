import { limitBytes } from "@knpkv/bounded-io"
import type { FleetService, HostConfiguration } from "@knpkv/herdr-fleet"
import type { Scope } from "effect"
import { Crypto, Effect, Predicate, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TerminalAgentNotFoundError, TerminalProtocolError, TerminalTransportError } from "./errors.js"
import { connectAgentId } from "./id.js"
import {
  hostReadsPerSecond,
  makePaneScrollReporter,
  makeReadWindow,
  readPaneScrollOffset,
  silentScrollReporter
} from "./internal/pane-scroll.js"
import { boundedTerminalLines, terminalEventMaxLineBytes } from "./internal/terminal-lines.js"
import { releaseTerminalControl, terminalKillOptions, terminalReleaseKillOptions } from "./internal/terminal-release.js"
import {
  HerdrTerminalEvent,
  type TerminalClientCommand,
  type TerminalSelection,
  type TerminalSessionEvent
} from "./model.js"

export type TerminalError =
  | TerminalAgentNotFoundError
  | TerminalProtocolError
  | TerminalTransportError

export interface TerminalSession {
  /** herdr's frames and close, plus the pane's scroll position as the connector reads it. */
  readonly events: Stream.Stream<TerminalSessionEvent, TerminalError>
  readonly send: (command: TerminalClientCommand) => Effect.Effect<void, TerminalTransportError>
}

export interface TerminalConnector {
  readonly open: (
    selection: TerminalSelection
  ) => Effect.Effect<TerminalSession, TerminalError, Scope.Scope>
}

export const terminalStderrMaxBytes = 1024 * 1024

export { boundedTerminalLines, terminalEventMaxLineBytes }

const transportError = (operation: string) => (cause: unknown) =>
  new TerminalTransportError({ cause, detail: String(cause), operation })

export const makeHerdrTerminalConnector = Effect.fn("HerdrTerminal.make")(function*(
  config: HostConfiguration,
  service: FleetService
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const cryptoService = yield* Crypto.Crypto
  // Shared by every session this connector opens, so the host as a whole stays under the cap.
  const scrollReads = makeReadWindow(hostReadsPerSecond)

  const open = Effect.fn("HerdrTerminal.open")(function*(selection: TerminalSelection) {
    if (selection.host.toLowerCase() !== config.host.toLowerCase()) {
      return yield* new TerminalAgentNotFoundError({
        agentId: selection.agentId,
        host: selection.host
      })
    }

    const inventory = yield* service.agents().pipe(
      Effect.mapError((cause) =>
        new TerminalTransportError({
          cause,
          detail: cause.detail,
          operation: "herdr.agent_list"
        })
      )
    )
    if (!inventory.available) {
      return yield* new TerminalTransportError({
        cause: inventory.error,
        detail: inventory.error ?? "Herdr agent inventory unavailable",
        operation: "herdr.agent_list"
      })
    }
    const candidates = yield* Effect.forEach(
      inventory.agents,
      (agent) =>
        (agent.agentId === null
          ? connectAgentId(config.host, agent.paneId).pipe(
            Effect.provideService(Crypto.Crypto, cryptoService)
          )
          : Effect.succeed(agent.agentId)).pipe(
            Effect.map((id) => ({ agent, id })),
            Effect.mapError(transportError("herdr.terminal.agent_id"))
          )
    )
    const candidate = candidates.find(({ id }) => id === selection.agentId)
    if (candidate === undefined) {
      return yield* new TerminalAgentNotFoundError({
        agentId: selection.agentId,
        host: selection.host
      })
    }
    const agent = candidate.agent

    const handle = yield* spawner
      .spawn(
        ChildProcess.make(
          config.herdrCommand,
          [
            "terminal",
            "session",
            "control",
            agent.paneId,
            "--cols",
            String(selection.cols),
            "--rows",
            String(selection.rows)
          ],
          {
            cwd: config.repository,
            forceKillAfter: terminalKillOptions.forceKillAfter,
            killSignal: "SIGTERM",
            stdin: { endOnDone: false, stream: "pipe" }
          }
        )
      )
      .pipe(Effect.mapError(transportError("herdr.terminal.spawn")))

    let forwardedScrolls = 0
    const scroll = selection.scrollState === true
      ? yield* makePaneScrollReporter(
        readPaneScrollOffset(spawner, config.herdrCommand, config.repository, agent.paneId),
        scrollReads,
        () => forwardedScrolls
      )
      : silentScrollReporter
    yield* scroll.request

    const send = Effect.fn("HerdrTerminal.send")(function*(command: TerminalClientCommand) {
      const bytes = new TextEncoder().encode(`${JSON.stringify(command)}\n`)
      yield* Stream.make(bytes).pipe(
        Stream.run(handle.stdin),
        Effect.mapError(transportError("herdr.terminal.write"))
      )
      if (command.type === "terminal.scroll") {
        forwardedScrolls += 1
        yield* scroll.request
      }
    })

    yield* Effect.addFinalizer(() =>
      Effect.interruptible(
        releaseTerminalControl(
          send({ type: "terminal.release" }),
          handle.exitCode,
          handle.kill(terminalReleaseKillOptions)
        )
      )
    )

    const terminalEvents = boundedTerminalLines(handle.stdout).pipe(
      Stream.mapEffect((line) =>
        Effect.try({
          try: () => Schema.decodeUnknownSync(HerdrTerminalEvent)(JSON.parse(line)),
          catch: (cause) =>
            new TerminalProtocolError({
              cause,
              detail: "Herdr emitted invalid terminal event JSON"
            })
        }).pipe(
          Effect.mapError((cause) =>
            Predicate.isTagged(cause, "TerminalProtocolError")
              ? cause
              : new TerminalProtocolError({
                cause,
                detail: "Herdr emitted an invalid terminal event"
              })
          )
        )
      ),
      // While the reader is scrolled back, herdr moves the position as output arrives.
      Stream.tap((event) => event.type === "terminal.frame" && scroll.scrolledBack() ? scroll.request : Effect.void),
      Stream.mapError((cause) =>
        Predicate.isTagged(cause, "TerminalProtocolError")
          ? cause
          : new TerminalTransportError({
            cause,
            detail: String(cause),
            operation: "herdr.terminal.read"
          })
      )
    )
    const stderrDrain = limitBytes(
      handle.stderr.pipe(Stream.mapError(transportError("herdr.terminal.stderr"))),
      terminalStderrMaxBytes
    ).pipe(
      Stream.catchTag("ByteLimitExceeded", ({ observedBytes }) =>
        Stream.fail(
          new TerminalTransportError({
            cause: observedBytes,
            detail: `Herdr terminal stderr exceeded ${terminalStderrMaxBytes} bytes`,
            operation: "herdr.terminal.stderr"
          })
        )),
      Stream.runDrain
    )
    const herdrEvents = Stream.merge(
      terminalEvents,
      Stream.fromEffect(stderrDrain).pipe(Stream.drain)
    )
    // The scroll states never end on their own; the session ends when herdr's stream does.
    const events = Stream.merge(herdrEvents, scroll.states, { haltStrategy: "left" }).pipe(
      Stream.concat(
        Stream.fromEffect(
          handle.exitCode.pipe(
            Effect.flatMap((code) =>
              Number(code) === 0
                ? Effect.void
                : Effect.fail(
                  new TerminalTransportError({
                    cause: code,
                    detail: `attach client exited code=${String(code)}`,
                    operation: "herdr.terminal.exit"
                  })
                )
            ),
            Effect.mapError((cause) =>
              Predicate.isTagged(cause, "TerminalTransportError")
                ? cause
                : new TerminalTransportError({
                  cause,
                  detail: String(cause),
                  operation: "herdr.terminal.exit"
                })
            )
          )
        ).pipe(Stream.drain)
      )
    )

    return { events, send } satisfies TerminalSession
  })

  return { open } satisfies TerminalConnector
})
