import { collectBoundedText, collectTailText, limitBytes, type TextTail } from "@knpkv/bounded-io"
import { AgentWorkLabel } from "@knpkv/herdr-connect"
import { makeCoordinatorLifecycle } from "@knpkv/herdr-coordinator"
import {
  type AgentDelegate,
  type AgentInventory,
  AgentStableId,
  AgentSummary,
  classifyAgentTask,
  type CoreJobPayload,
  FleetOperationError,
  type HostConfiguration,
  type HostOperations,
  type LocalJobPayload,
  type WorkerStarted
} from "@knpkv/herdr-fleet"
import { Clock, Config, Effect, Option, Path, Schema, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { makeSessionTaskReader } from "./internal/agent-task-session.js"
import { makeTaskWorkSource, registerTaskWorkSource } from "./internal/agent-task-work-source.js"
import {
  branchTaskFacts,
  decodeTaskBranchTarget,
  type TaskBranchTarget,
  type TaskWorkFacts
} from "./internal/agent-task-work.js"
import { makeHostCommand } from "./internal/host-command.js"

const HerdrAgentFields = {
  agent_status: Schema.String,
  agent_session: Schema.optionalKey(Schema.Unknown),
  cwd: Schema.String,
  foreground_cwd: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  pane_id: Schema.String,
  state_change_seq: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })
  ),
  tokens: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
}

const HerdrAgent = Schema.Struct({
  agent: Schema.String,
  ...HerdrAgentFields
})

const HerdrLaunchPendingAgent = Schema.Struct({
  launch_pending: Schema.Literal(true),
  ...HerdrAgentFields
})

const HerdrAgentEntry = Schema.Union([
  HerdrLaunchPendingAgent,
  HerdrAgent
])

const isHerdrLaunchPendingAgent = Schema.is(HerdrLaunchPendingAgent)
const isHerdrAgent = (
  agent: typeof HerdrAgentEntry.Type
): agent is typeof HerdrAgent.Type => !isHerdrLaunchPendingAgent(agent)

const HerdrAgents = Schema.Struct({
  result: Schema.Struct({
    agents: Schema.Array(HerdrAgentEntry)
  })
})

const operationError = (operation: string) => (cause: unknown) =>
  new FleetOperationError({ cause, detail: String(cause), operation })

/**
 * Reserves transport-envelope headroom when one-byte control output expands to
 * six JSON bytes beside the largest accepted job payload.
 */
export const commandOutputMaxBytes = 128 * 1024

/**
 * The end of a build's output kept per stream. Smaller than
 * {@link commandOutputMaxBytes}, leaving room for the omission line and the
 * exit code around it.
 */
export const commandOutputTailBytes = 64 * 1024

/**
 * How a command's output is read. `whole` is for output a caller parses: past
 * {@link commandOutputMaxBytes} the job fails, and the command is stopped.
 * `tail` is for a build log nothing parses: the command runs to completion,
 * its exit code alone decides the outcome, and only the last
 * {@link commandOutputTailBytes} of each stream are kept.
 */
type OutputPolicy = "whole" | "tail"

const textEncoder = new TextEncoder()

/** The last `maxBytes` of `text`, starting on a character boundary. */
const lastBytes = (text: string, maxBytes: number): string => {
  const bytes = textEncoder.encode(text)
  if (bytes.byteLength <= maxBytes) return text
  let start = bytes.byteLength - Math.max(0, maxBytes)
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1
  return new TextDecoder().decode(bytes.subarray(start))
}

/**
 * Why a command failed. A build log's failure carries its stdout tail too,
 * where tools like `brew bundle` write the error that explains it; stdout
 * gets whatever of {@link commandOutputMaxBytes} the rest leaves.
 */
const failureDetail = (exitCode: number, stderr: string, stdout: string, policy: OutputPolicy): string => {
  const head = stderr.trim() === ""
    ? `command exited with code ${String(exitCode)}`
    : `command exited with code ${String(exitCode)}: ${stderr.trim()}`
  const output = stdout.trim()
  if (policy === "whole" || output === "") return head
  const label = "\nstdout:\n"
  const room = commandOutputMaxBytes - textEncoder.encode(head + label).byteLength
  return room <= 0 ? head : `${head}${label}${lastBytes(output, room)}`
}

/** A kept tail, led by how much came before it when anything did. */
const framedTail = ({ omittedBytes, text }: TextTail): string =>
  omittedBytes === 0 ? text : `[${String(omittedBytes)} earlier bytes omitted]\n${text}`

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

export const makeHostOperations = Effect.fn("HostOperations.make")(function*(
  config: HostConfiguration
) {
  const paths = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const workSource = yield* makeTaskWorkSource()
  const home = yield* Config.option(Config.String("HOME"))
  const claudeConfig = yield* Config.option(Config.String("CLAUDE_CONFIG_DIR"))
  const codexHome = yield* Config.option(Config.String("CODEX_HOME"))
  const claudeRoot = Option.getOrElse(
    claudeConfig,
    () => Option.isSome(home) ? paths.join(home.value, ".claude") : undefined
  )
  const codexRoot = Option.getOrElse(
    codexHome,
    () => Option.isSome(home) ? paths.join(home.value, ".codex") : undefined
  )
  const sessionReader = yield* makeSessionTaskReader({
    claudeProjects: claudeRoot === undefined ? undefined : paths.join(claudeRoot, "projects"),
    codexSessions: codexRoot === undefined ? undefined : paths.join(codexRoot, "sessions")
  })

  const outputLimitError = (operation: string, observedBytes: number) =>
    new FleetOperationError({
      cause: observedBytes,
      detail: `command output exceeded ${commandOutputMaxBytes} bytes`,
      operation
    })

  const collectOutput = (
    operation: string,
    stream: Stream.Stream<Uint8Array, unknown>
  ) =>
    collectBoundedText(stream.pipe(Stream.mapError(operationError(operation))), commandOutputMaxBytes).pipe(
      Effect.catchTag(
        "ByteLimitExceeded",
        ({ observedBytes }) => Effect.fail(outputLimitError(operation, observedBytes))
      )
    )

  const collectWithPolicy = (
    policy: OutputPolicy,
    operation: string,
    stream: Stream.Stream<Uint8Array, unknown>
  ) =>
    policy === "whole"
      ? collectOutput(operation, stream)
      : collectTailText(stream.pipe(Stream.mapError(operationError(operation))), commandOutputTailBytes).pipe(
        Effect.map(framedTail)
      )

  const runCommand = Effect.fn("HostOperations.runCommand")(function*(
    operation: string,
    commandLine: ReadonlyArray<string>,
    policy: OutputPolicy = "whole"
  ) {
    const command = commandLine[0]
    if (command === undefined) {
      return yield* new FleetOperationError({
        cause: commandLine,
        detail: "configured command is empty",
        operation
      })
    }
    const child = makeHostCommand(command, commandLine.slice(1), {
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
            stderr: collectWithPolicy(policy, operation, handle.stderr),
            stdout: collectWithPolicy(policy, operation, handle.stdout)
          }, { concurrency: "unbounded" }).pipe(
            Effect.flatMap(({ exitCode, stderr, stdout }) =>
              Number(exitCode) === 0
                ? Effect.succeed(stdout)
                : Effect.fail(
                  new FleetOperationError({
                    cause: exitCode,
                    detail: failureDetail(Number(exitCode), stderr, stdout, policy),
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
        Effect.gen(function*() {
          const entries = parsed.result.agents.filter(isHerdrAgent)
          const workSnapshot = yield* workSource.snapshot
          const now = yield* Clock.currentTimeMillis
          const observations = workSnapshot.observed ?? []
          const targets = new Map<string, TaskBranchTarget | undefined>()
          if (observations.some((observation) => observation.pullRequest !== null)) {
            const directories = [...new Set(entries.map((agent) => agent.foreground_cwd ?? agent.cwd))]
            yield* Effect.forEach(directories, (directory) =>
              Effect.all({
                origin: runCommand("task.git.origin", ["git", "-C", directory, "remote", "get-url", "origin"]),
                branch: runCommand("task.git.branch", ["git", "-C", directory, "symbolic-ref", "--short", "HEAD"])
              }).pipe(
                Effect.map(({ branch, origin }) => {
                  targets.set(directory, decodeTaskBranchTarget(origin.trim(), branch.trim()))
                }),
                Effect.catchTag("FleetOperationError", () => Effect.void)
              ), { concurrency: 4 })
          }
          return yield* Effect.forEach(
            entries,
            (agent) => {
              return Effect.gen(function*() {
                const basename = paths.basename(agent.foreground_cwd ?? agent.cwd)
                const work = yield* Schema.decodeUnknownEffect(AgentWorkLabel)(
                  basename === "" ? "root" : basename
                ).pipe(Effect.mapError(operationError("herdr.agent_list.work")))
                const lineage = yield* decodeLineage(agent.tokens)
                const activity = agent.agent_status !== "working"
                  ? undefined
                  : yield* sessionReader({ provider: agent.agent, cwd: agent.cwd, session: agent.agent_session })
                const target = targets.get(agent.foreground_cwd ?? agent.cwd)
                const workFacts = target === undefined
                  ? { ci: "unknown", review: "unknown" } satisfies TaskWorkFacts
                  : branchTaskFacts(workSnapshot, target, now)
                const taskFacts = activity === undefined
                  ? { status: agent.agent_status, ...workFacts }
                  : { status: agent.agent_status, activity, ...workFacts }
                return yield* Schema.decodeUnknownEffect(AgentSummary)({
                  agentId: lineage.agentId,
                  activityRevision: agent.state_change_seq,
                  kind: agent.agent,
                  name: agent.name ?? `${agent.agent}@${agent.pane_id}`,
                  paneId: agent.pane_id,
                  parentAgentId: lineage.parentAgentId,
                  relation: lineage.relation,
                  status: agent.agent_status,
                  taskKind: classifyAgentTask(taskFacts),
                  work
                }).pipe(
                  Effect.mapError(operationError("herdr.agent_list.agent"))
                )
              })
            }
          )
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
      const child = makeHostCommand(command, commandLine.slice(1), {
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
              const stdout = limitBytes(handle.stdout, commandOutputMaxBytes).pipe(
                Stream.catchTag("ByteLimitExceeded", ({ observedBytes }) =>
                  Stream.fail(outputLimitError(operation, observedBytes))),
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
        return runCommand("nix.check", config.checkCommand, "tail")
      case "nix.apply":
        return config.applyCommand === null
          ? Effect.fail(
            new FleetOperationError({
              cause: config.host,
              detail: "Nix apply is not configured on this host",
              operation: "nix.apply"
            })
          )
          // The job id lets the apply command record this job's own outcome,
          // which hostd reads to settle the job if the apply restarts it.
          : runCommand("nix.apply", [...config.applyCommand, payload.ref, jobId], "tail")
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
      case "work.reconcile":
      case "work.admit":
      case "work.recover":
      case "work.reassign":
      case "work.abandon":
        return Effect.fail(
          new FleetOperationError({
            cause: payload.kind,
            detail: "Work authority requires the host's approved WorkService adapter",
            operation: payload.kind
          })
        )
      case "sandbox.lease":
      case "sandbox.extend":
      case "sandbox.release":
      case "sandbox.reset":
      case "sandbox.budget.lift":
        return Effect.fail(
          new FleetOperationError({
            cause: payload.kind,
            detail: "sandbox jobs run only on the host that owns the sandbox pool",
            // Refused before any sandbox state is read, so nothing was committed.
            disposition: "rejected",
            operation: payload.kind
          })
        )
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

  yield* registerTaskWorkSource(listAgents, workSource.register)
  return {
    inspect,
    listAgents,
    run: runPayload,
    runLocal,
    runCoordinatorChat
  } satisfies HostOperations
})
