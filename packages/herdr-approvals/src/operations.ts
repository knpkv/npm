import { AgentWorkLabel } from "@knpkv/herdr-connect"
import { makeCoordinatorLifecycle } from "@knpkv/herdr-coordinator"
import {
  type AgentDelegate,
  type AgentInventory,
  AgentStableId,
  AgentSummary,
  type CoreJobPayload,
  FleetOperationError,
  type HostConfiguration,
  type HostOperations,
  type LocalJobPayload,
  type WorkerStarted
} from "@knpkv/herdr-fleet"
import { Effect, Path, Ref, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const HerdrAgents = Schema.Struct({
  result: Schema.Struct({
    agents: Schema.Array(
      Schema.Struct({
        agent: Schema.String,
        agent_status: Schema.String,
        cwd: Schema.String,
        foreground_cwd: Schema.optionalKey(Schema.String),
        name: Schema.optionalKey(Schema.NullOr(Schema.String)),
        pane_id: Schema.String,
        state_change_seq: Schema.Number.check(
          Schema.isInt(),
          Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })
        ),
        tokens: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
      })
    )
  })
})

const operationError = (operation: string) => (cause: unknown) =>
  new FleetOperationError({ cause, detail: String(cause), operation })

/**
 * Reserves transport-envelope headroom when one-byte control output expands to
 * six JSON bytes beside the largest accepted job payload.
 */
export const commandOutputMaxBytes = 128 * 1024

type AgentLineage = Pick<
  typeof AgentSummary.Type,
  "agentId" | "parentAgentId" | "relation"
>

const decodeLineage = Effect.fn("HostOperations.decodeLineage")(function*(
  tokens: Readonly<Record<string, string>> | undefined
) {
  const agentId = tokens?.agent_id
  const parentAgentId = tokens?.parent_agent_id
  const relation = tokens?.relation
  const version = tokens?.lineage_version
  const hasLineage = agentId !== undefined || parentAgentId !== undefined ||
    relation !== undefined || version !== undefined
  if (!hasLineage) {
    return {
      agentId: null,
      parentAgentId: null,
      relation: null
    } satisfies AgentLineage
  }
  if (version !== "hostd.agent-lineage.v1" || agentId === undefined) {
    return yield* new FleetOperationError({
      cause: tokens,
      detail: "Herdr agent lineage metadata is incomplete or has an unsupported version",
      operation: "herdr.agent_list.lineage"
    })
  }
  const decodedAgentId = yield* Schema.decodeUnknownEffect(AgentStableId)(
    agentId
  ).pipe(Effect.mapError(operationError("herdr.agent_list.lineage.agent_id")))
  if (relation === "root" && parentAgentId === undefined) {
    return {
      agentId: decodedAgentId,
      parentAgentId: null,
      relation: null
    } satisfies AgentLineage
  }
  if (
    (relation === "delegated" || relation === "pair" || relation === "review") &&
    parentAgentId !== undefined
  ) {
    const decodedParent = yield* Schema.decodeUnknownEffect(AgentStableId)(
      parentAgentId
    ).pipe(Effect.mapError(operationError("herdr.agent_list.lineage.parent_agent_id")))
    return {
      agentId: decodedAgentId,
      parentAgentId: decodedParent,
      relation
    } satisfies AgentLineage
  }
  return yield* new FleetOperationError({
    cause: tokens,
    detail: "Herdr agent lineage relationship is malformed",
    operation: "herdr.agent_list.lineage"
  })
})

interface CommandOutput {
  readonly bytes: number
  readonly chunks: ReadonlyArray<Uint8Array>
}

export const makeHostOperations = Effect.fn("HostOperations.make")(function*(
  config: HostConfiguration
) {
  const paths = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const collectOutput = (
    operation: string,
    stream: Stream.Stream<Uint8Array, unknown>
  ) =>
    stream.pipe(
      Stream.mapError(operationError(operation)),
      Stream.runFoldEffect(
        (): CommandOutput => ({ bytes: 0, chunks: [] }),
        (output, chunk) => {
          const bytes = output.bytes + chunk.byteLength
          return bytes > commandOutputMaxBytes
            ? Effect.fail(
              new FleetOperationError({
                cause: bytes,
                detail: `command output exceeded ${commandOutputMaxBytes} bytes`,
                operation
              })
            )
            : Effect.succeed({
              bytes,
              chunks: [...output.chunks, chunk]
            })
        }
      ),
      Effect.flatMap((output) =>
        Stream.fromIterable(output.chunks).pipe(
          Stream.decodeText(),
          Stream.mkString,
          Effect.mapError(operationError(operation))
        )
      )
    )

  const runCommand = Effect.fn("HostOperations.runCommand")(function*(
    operation: string,
    commandLine: ReadonlyArray<string>
  ) {
    const command = commandLine[0]
    if (command === undefined) {
      return yield* new FleetOperationError({
        cause: commandLine,
        detail: "configured command is empty",
        operation
      })
    }
    const child = ChildProcess.make(command, commandLine.slice(1), {
      cwd: config.repository
    })
    return yield* Effect.scoped(
      spawner.spawn(child).pipe(
        Effect.mapError(operationError(operation)),
        Effect.flatMap((handle) =>
          Effect.all({
            exitCode: handle.exitCode.pipe(
              Effect.mapError(operationError(operation))
            ),
            stderr: collectOutput(operation, handle.stderr),
            stdout: collectOutput(operation, handle.stdout)
          }, { concurrency: "unbounded" }).pipe(
            Effect.flatMap(({ exitCode, stderr, stdout }) =>
              Number(exitCode) === 0
                ? Effect.succeed(stdout)
                : Effect.fail(
                  new FleetOperationError({
                    cause: exitCode,
                    detail: stderr.trim() === ""
                      ? `command exited with code ${String(exitCode)}`
                      : `command exited with code ${String(exitCode)}: ${stderr.trim()}`,
                    operation
                  })
                )
            )
          )
        ),
        Effect.timeoutOrElse({
          duration: "30 minutes",
          orElse: () =>
            Effect.fail(
              new FleetOperationError({
                cause: "30 minutes",
                detail: "command timed out after 30 minutes",
                operation
              })
            )
        }),
        Effect.map((output) => output.trim())
      )
    )
  })

  const listAgents = Effect.fn("HostOperations.listAgents")(function*() {
    return yield* runCommand("herdr.agent_list", [config.herdrCommand, "agent", "list"]).pipe(
      Effect.flatMap((output) =>
        Effect.try({
          try: () => Schema.decodeUnknownSync(HerdrAgents)(JSON.parse(output)),
          catch: operationError("herdr.agent_list.decode")
        })
      ),
      Effect.flatMap((parsed) =>
        Effect.forEach(parsed.result.agents, (agent) => {
          return Effect.gen(function*() {
            const basename = paths.basename(agent.foreground_cwd ?? agent.cwd)
            const work = yield* Schema.decodeUnknownEffect(AgentWorkLabel)(
              basename === "" ? "root" : basename
            ).pipe(Effect.mapError(operationError("herdr.agent_list.work")))
            const lineage = yield* decodeLineage(agent.tokens)
            return yield* Schema.decodeUnknownEffect(AgentSummary)({
              agentId: lineage.agentId,
              activityRevision: agent.state_change_seq,
              kind: agent.agent,
              name: agent.name ?? `${agent.agent}@${agent.pane_id}`,
              paneId: agent.pane_id,
              parentAgentId: lineage.parentAgentId,
              relation: lineage.relation,
              status: agent.agent_status,
              work
            }).pipe(
              Effect.mapError(operationError("herdr.agent_list.agent"))
            )
          })
        })
      ),
      Effect.map(
        (agents): AgentInventory => ({ agents, available: true, error: null })
      ),
      Effect.catchTag(
        "FleetOperationError",
        (error) =>
          Effect.succeed({
            agents: [],
            available: false,
            error: `${error.operation}: ${error.detail}`
          })
      )
    )
  })

  const runCoordinatorCommand = Effect.fn("HostOperations.runCoordinatorCommand")(
    function*(
      operation: string,
      commandLine: ReadonlyArray<string>,
      workerStarted: WorkerStarted,
      jobId: string
    ) {
      const command = commandLine[0]
      if (command === undefined) {
        return yield* new FleetOperationError({
          cause: commandLine,
          detail: "configured coordinator command is empty",
          operation
        })
      }
      const child = ChildProcess.make(command, commandLine.slice(1), {
        cwd: config.repository
      })
      const validatedWorkerStarted: WorkerStarted = (identity) => {
        const configured = config.machines.some(
          ({ host }) => host.toLowerCase() === identity.host.toLowerCase()
        )
        return configured
          ? workerStarted(identity)
          : Effect.fail(
            new FleetOperationError({
              cause: identity.host,
              detail: "coordinator worker identity names an unknown fleet host",
              operation: `${operation}.worker_host`
            })
          )
      }
      return yield* Effect.scoped(
        spawner.spawn(child).pipe(
          Effect.mapError(operationError(operation)),
          Effect.flatMap((handle) =>
            Effect.gen(function*() {
              const lifecycle = makeCoordinatorLifecycle(jobId, validatedWorkerStarted)
              const stdoutBytes = yield* Ref.make(0)
              const stdout = handle.stdout.pipe(
                Stream.mapEffect((chunk) =>
                  Ref.updateAndGet(stdoutBytes, (bytes) => bytes + chunk.byteLength).pipe(
                    Effect.flatMap((bytes) =>
                      bytes > commandOutputMaxBytes
                        ? Effect.fail(
                          new FleetOperationError({
                            cause: bytes,
                            detail: `command output exceeded ${commandOutputMaxBytes} bytes`,
                            operation
                          })
                        )
                        : Effect.succeed(chunk)
                    )
                  )
                ),
                Stream.decodeText(),
                Stream.splitLines,
                Stream.runForEach(lifecycle.accept),
                Effect.mapError(operationError(`${operation}.lifecycle`))
              )
              const { exitCode, stderr } = yield* Effect.all({
                exitCode: handle.exitCode.pipe(
                  Effect.mapError(operationError(operation))
                ),
                stdout,
                stderr: collectOutput(operation, handle.stderr)
              }, { concurrency: "unbounded" })
              if (Number(exitCode) !== 0) {
                return yield* new FleetOperationError({
                  cause: exitCode,
                  detail: stderr.trim() === ""
                    ? `command exited with code ${String(exitCode)}`
                    : `command exited with code ${String(exitCode)}: ${stderr.trim()}`,
                  operation
                })
              }
              const result = yield* lifecycle.finish().pipe(
                Effect.mapError(operationError(`${operation}.lifecycle`))
              )
              return result.reply
            })
          ),
          Effect.timeoutOrElse({
            duration: "30 minutes",
            orElse: () =>
              Effect.fail(
                new FleetOperationError({
                  cause: "30 minutes",
                  detail: "command timed out after 30 minutes",
                  operation
                })
              )
          })
        )
      )
    }
  )

  const inspect = Effect.fn("HostOperations.inspect")(function*() {
    const { branch, revision, status } = yield* Effect.all({
      branch: runCommand("git.branch", ["git", "branch", "--show-current"]),
      revision: runCommand("git.revision", ["git", "rev-parse", "HEAD"]),
      status: runCommand("git.status", ["git", "status", "--porcelain"])
    })
    return {
      applyConfigured: config.applyCommand !== null,
      branch,
      dirty: status !== "",
      repository: config.repository,
      revision
    }
  })

  const runPayload = (payload: CoreJobPayload, workerStarted: WorkerStarted, jobId: string) => {
    switch (payload.kind) {
      case "nix.check":
        return runCommand("nix.check", config.checkCommand)
      case "nix.apply":
        return config.applyCommand === null
          ? Effect.fail(
            new FleetOperationError({
              cause: config.host,
              detail: "Nix apply is not configured on this host",
              operation: "nix.apply"
            })
          )
          : runCommand("nix.apply", [...config.applyCommand, payload.ref])
      case "agent.delegate":
        return runCoordinatorCommand(
          "agent.delegate",
          [
            ...config.coordinatorCommand,
            "delegate",
            jobId,
            JSON.stringify(payload)
          ],
          workerStarted,
          jobId
        )
      case "agent.message":
        return runCommand("agent.message", [
          config.herdrCommand,
          "agent",
          "prompt",
          payload.session,
          payload.message,
          "--wait",
          "--timeout",
          "900000"
        ])
    }
  }

  const runLocal = (payload: LocalJobPayload) =>
    config.browserMcpRecoverCommand === null
      ? Effect.fail(
        new FleetOperationError({
          cause: payload.kind,
          detail: "browser MCP recovery is not configured on this host",
          operation: payload.kind
        })
      )
      : runCommand(payload.kind, config.browserMcpRecoverCommand)

  const runCoordinatorChat = (
    payload: AgentDelegate,
    workerStarted: WorkerStarted,
    jobId: string
  ) =>
    runCoordinatorCommand(
      "agent.delegate.chat",
      [
        ...config.coordinatorCommand,
        "chat",
        jobId,
        JSON.stringify(payload)
      ],
      workerStarted,
      jobId
    )

  return {
    inspect,
    listAgents,
    run: runPayload,
    runLocal,
    runCoordinatorChat
  } satisfies HostOperations
})
