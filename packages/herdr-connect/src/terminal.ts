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
  readonly buffer: Uint8Array
  readonly length: number
}

const terminalLineInitialBytes = 64 * 1_024

const emptyTerminalLine = (): TerminalLineState => ({
  buffer: new Uint8Array(terminalLineInitialBytes),
  length: 0
})

const decodeTerminalLine = (bytes: Uint8Array): string => {
  const content = bytes.at(-1) === 13 ? bytes.subarray(0, -1) : bytes
  return new TextDecoder().decode(content)
}

const growTerminalLineBuffer = (
  buffer: Uint8Array,
  requiredBytes: number,
  onBufferCopy: ((bytes: number) => void) | undefined
): Uint8Array => {
  if (requiredBytes <= buffer.byteLength) return buffer
  let capacity = buffer.byteLength
  while (capacity < requiredBytes) {
    capacity = Math.min(capacity * 2, terminalEventMaxLineBytes)
  }
  const grown = new Uint8Array(capacity)
  onBufferCopy?.(buffer.byteLength)
  grown.set(buffer)
  return grown
}

/** @internal Exposes copied-byte accounting only for the deterministic complexity regression. */
export const boundedTerminalLines = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  onBufferCopy?: (bytes: number) => void
) =>
  stream.pipe(
    Stream.mapAccumEffect(
      emptyTerminalLine,
      (state, chunk) => {
        let buffer = state.buffer
        let length = state.length
        const lines: Array<string> = []
        let offset = 0
        while (offset < chunk.byteLength) {
          const newline = chunk.indexOf(10, offset)
          const end = newline === -1 ? chunk.byteLength : newline
          const nextLength = length + end - offset
          if (nextLength > terminalEventMaxLineBytes) {
            return Effect.fail(
              new TerminalProtocolError({
                cause: nextLength,
                detail: `Herdr terminal event exceeded ${terminalEventMaxLineBytes} bytes`
              })
            )
          }
          buffer = growTerminalLineBuffer(buffer, nextLength, onBufferCopy)
          buffer.set(chunk.subarray(offset, end), length)
          length = nextLength
          if (newline === -1) break
          lines.push(decodeTerminalLine(buffer.subarray(0, length)))
          length = 0
          offset = newline + 1
        }
        const result: readonly [TerminalLineState, ReadonlyArray<string>] = [
          { buffer, length },
          lines
        ]
        return Effect.succeed(result)
      },
      {
        onHalt: (state) =>
          state.length === 0
            ? []
            : [decodeTerminalLine(state.buffer.subarray(0, state.length))]
      }
    )
  )

const transportError = (operation: string) => (cause: unknown) =>
  new TerminalTransportError({ cause, detail: String(cause), operation })

/** @internal Owns the bounded terminal-control shutdown sequence. */
export const releaseTerminalControl = Effect.fn("HerdrTerminal.releaseControl")(function*<
  ReleaseError,
  ExitError,
  KillError,
  ReleaseRequirements,
  ExitRequirements,
  KillRequirements
>(
  release: Effect.Effect<void, ReleaseError, ReleaseRequirements>,
  exitCode: Effect.Effect<unknown, ExitError, ExitRequirements>,
  kill: Effect.Effect<unknown, KillError, KillRequirements>
) {
  yield* release.pipe(
    Effect.timeoutOrElse({
      duration: "1 second",
      orElse: () => kill
    }),
    Effect.ignore
  )
  yield* exitCode.pipe(
    Effect.timeoutOrElse({
      duration: "1 second",
      orElse: () => kill
    }),
    Effect.ignore
  )
})

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
      releaseTerminalControl(
        send({ type: "terminal.release" }),
        handle.exitCode,
        handle.kill()
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
