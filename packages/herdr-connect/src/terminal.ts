import type { FleetService, HostConfiguration } from "@knpkv/herdr-fleet"
import type { Scope } from "effect"
import { Crypto, Effect, Predicate, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { TerminalAgentNotFoundError, TerminalProtocolError, TerminalTransportError } from "./errors.js"
import { connectAgentId } from "./id.js"
import { HerdrTerminalEvent, type TerminalClientCommand, type TerminalSelection } from "./model.js"

export type TerminalError =
  | TerminalAgentNotFoundError
  | TerminalProtocolError
  | TerminalTransportError

export interface TerminalSession {
  readonly events: Stream.Stream<HerdrTerminalEvent, TerminalError>
  readonly send: (command: TerminalClientCommand) => Effect.Effect<void, TerminalTransportError>
}

export interface TerminalConnector {
  readonly open: (
    selection: TerminalSelection
  ) => Effect.Effect<TerminalSession, TerminalError, Scope.Scope>
}

export const terminalStderrMaxBytes = 1024 * 1024
export const terminalEventMaxLineBytes = 4 * 1024 * 1024 + 4 * 1024

interface TerminalLineState {
  readonly bytes: ReadonlyArray<number>
}

const emptyTerminalLine = (): TerminalLineState => ({ bytes: [] })

const decodeTerminalLine = (bytes: ReadonlyArray<number>): string => {
  const content = bytes.at(-1) === 13 ? bytes.slice(0, -1) : bytes
  return new TextDecoder().decode(Uint8Array.from(content))
}

const boundedTerminalLines = <E, R>(stream: Stream.Stream<Uint8Array, E, R>) =>
  stream.pipe(
    Stream.mapAccumEffect(
      emptyTerminalLine,
      (state, chunk) => {
        const pending = [...state.bytes]
        const lines: Array<string> = []
        for (const byte of chunk) {
          if (byte === 10) {
            lines.push(decodeTerminalLine(pending))
            pending.length = 0
          } else {
            pending.push(byte)
            if (pending.length > terminalEventMaxLineBytes) {
              return Effect.fail(
                new TerminalProtocolError({
                  cause: pending.length,
                  detail: `Herdr terminal event exceeded ${terminalEventMaxLineBytes} bytes`
                })
              )
            }
          }
        }
        const result: readonly [TerminalLineState, ReadonlyArray<string>] = [
          { bytes: pending },
          lines
        ]
        return Effect.succeed(result)
      },
      {
        onHalt: (state) =>
          state.bytes.length === 0
            ? []
            : [decodeTerminalLine(state.bytes)]
      }
    )
  )

const transportError = (operation: string) => (cause: unknown) =>
  new TerminalTransportError({ cause, detail: String(cause), operation })

export const makeHerdrTerminalConnector = Effect.fn("HerdrTerminal.make")(function*(
  config: HostConfiguration,
  service: FleetService
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const cryptoService = yield* Crypto.Crypto

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
            stdin: { endOnDone: false, stream: "pipe" }
          }
        )
      )
      .pipe(Effect.mapError(transportError("herdr.terminal.spawn")))

    const send = Effect.fn("HerdrTerminal.send")(function*(command: TerminalClientCommand) {
      const bytes = new TextEncoder().encode(`${JSON.stringify(command)}\n`)
      yield* Stream.make(bytes).pipe(
        Stream.run(handle.stdin),
        Effect.mapError(transportError("herdr.terminal.write"))
      )
    })

    yield* Effect.addFinalizer(() =>
      send({ type: "terminal.release" }).pipe(
        Effect.ignore,
        Effect.andThen(
          handle.exitCode.pipe(
            Effect.timeoutOrElse({
              duration: "1 second",
              orElse: () => handle.kill()
            })
          )
        ),
        Effect.ignore
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
    const stderrDrain = handle.stderr.pipe(
      Stream.mapError(transportError("herdr.terminal.stderr")),
      Stream.runFoldEffect((): number => 0, (bytes, chunk) => {
        const next = bytes + chunk.byteLength
        return next > terminalStderrMaxBytes
          ? Effect.fail(
            new TerminalTransportError({
              cause: next,
              detail: `Herdr terminal stderr exceeded ${terminalStderrMaxBytes} bytes`,
              operation: "herdr.terminal.stderr"
            })
          )
          : Effect.succeed(next)
      })
    )
    const events = Stream.merge(
      terminalEvents,
      Stream.fromEffect(stderrDrain).pipe(Stream.drain)
    ).pipe(
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
