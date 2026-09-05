import { Clock, Crypto, Effect, Encoding, Ref, Result, Schema, Semaphore } from "effect"
import {
  FleetApprovalError,
  FleetJobNotFoundError,
  FleetOperationError,
  FleetStoreError,
  FleetTransitionConflictError,
  FleetValidationError
} from "./errors.js"
import { jobHash } from "./hash.js"
import { fleetResponseBodyMaxBytes } from "./limits.js"
import {
  agentConnectTarget,
  type AgentDelegate,
  type AgentInventory,
  type AgentWorkerIdentity,
  type AgentWorkerObservation,
  AgentWorkerObservations,
  type CoreJobPayload,
  type HostDetails,
  HostOperationReceipt,
  JobActor,
  type JobHash,
  type JobPayload,
  type JobRecord,
  type JobRequest,
  type LocalJobPayload,
  type PendingApprovalCursor,
  requiresApproval,
  workerObservationMaxLength
} from "./model.js"
import type { JobStore } from "./store.js"

export type { AgentInventory, AgentSummary, HostDetails } from "./model.js"

export type WorkerStarted = (
  identity: AgentWorkerIdentity
) => Effect.Effect<void, FleetOperationError>

export const hostOperationTerminalDetailMaxLength = 20_000
const terminalDetailEncoder = new TextEncoder()
const HostOperationTerminalDetail = Schema.String.check(
  Schema.isMaxLength(hostOperationTerminalDetailMaxLength),
  Schema.makeFilter(
    (detail) => terminalDetailEncoder.encode(detail).byteLength <= hostOperationTerminalDetailMaxLength,
    { expected: `UTF-8 text no larger than ${hostOperationTerminalDetailMaxLength} bytes` }
  )
)

export const HostOperationTerminal = Schema.Union([
  Schema.Struct({ type: Schema.Literal("settled"), detail: HostOperationTerminalDetail }),
  Schema.Struct({ type: Schema.Literal("delivery_failed"), detail: HostOperationTerminalDetail }),
  Schema.Struct({ type: Schema.Literal("task_failed"), detail: HostOperationTerminalDetail })
])
export type HostOperationTerminal = typeof HostOperationTerminal.Type

const terminalDetailTruncationSuffix = "\n[truncated; authoritative detail remains in coordinator]"

/** Projects an authoritative coordinator detail into Fleet's bounded summary. */
export const summarizeHostOperationTerminalDetail = (detail: string): string => {
  if (
    detail.length <= hostOperationTerminalDetailMaxLength &&
    terminalDetailEncoder.encode(detail).byteLength <= hostOperationTerminalDetailMaxLength
  ) return detail
  const boundary = hostOperationTerminalDetailMaxLength -
    terminalDetailEncoder.encode(terminalDetailTruncationSuffix).byteLength
  let bounded = ""
  let byteLength = 0
  for (const character of detail) {
    const characterBytes = terminalDetailEncoder.encode(character).byteLength
    if (byteLength + characterBytes > boundary) break
    bounded += character
    byteLength += characterBytes
  }
  return `${bounded}${terminalDetailTruncationSuffix}`
}

export type HostOperationLifecycle = {
  /** Persists a durable receipt while the fleet job remains running. */
  readonly accepted: (receipt: string) => Effect.Effect<void, FleetOperationError>
  /** Mirrors the authoritative durable terminal event into the fleet job. */
  readonly terminal: (event: HostOperationTerminal) => Effect.Effect<void, FleetOperationError>
}

export type ResumeHostOperation = (
  payload: CoreJobPayload,
  workerStarted: WorkerStarted,
  jobId: string,
  actor: JobActor,
  receipt: string | null,
  lifecycle: HostOperationLifecycle,
  persistedWorker: AgentWorkerIdentity | null
) => Effect.Effect<void, FleetOperationError>

export type HostOperationRecovery = {
  /** Identifies operations whose deterministic Fleet job ID is their durable submission identity. */
  readonly matches: (payload: CoreJobPayload) => boolean
  /**
   * Rejoins or idempotently completes submission, including before Fleet persisted a receipt.
   * A running job's exact persisted worker is supplied for authoritative replay without discovery.
   * It must attach observation in its owning scope and return without waiting for terminal work.
   */
  readonly resume: ResumeHostOperation
}

export type HostOperations = {
  readonly listAgents: () => Effect.Effect<AgentInventory, FleetOperationError>
  readonly inspect: () => Effect.Effect<HostDetails, FleetOperationError>
  readonly run: (
    payload: CoreJobPayload,
    workerStarted: WorkerStarted,
    jobId: string,
    actor: JobActor,
    lifecycle: HostOperationLifecycle
  ) => Effect.Effect<string, FleetOperationError>
  readonly runLocal: (
    payload: LocalJobPayload
  ) => Effect.Effect<string, FleetOperationError>
  readonly runCoordinatorChat: (
    payload: AgentDelegate,
    workerStarted: WorkerStarted,
    jobId: string,
    actor: JobActor,
    lifecycle: HostOperationLifecycle
  ) => Effect.Effect<string, FleetOperationError>
  /** Explicit crash recovery for operations backed by another durable store. */
  readonly recovery?: HostOperationRecovery
}

export type Approval = {
  readonly hash: JobHash
  readonly nonce: string
}

export const pendingApprovalPageMaxRecords = 8

type Options = {
  readonly host: string
  readonly store: JobStore
  readonly operations: HostOperations
  readonly approvalEnabled: boolean
  readonly now?: Effect.Effect<number>
  readonly id?: Effect.Effect<string>
  readonly nonce?: Effect.Effect<string>
  readonly approvalTtlMs?: number
}

type JobChange = Partial<
  Pick<
    JobRecord,
    | "status"
    | "result"
    | "acceptedReceipt"
    | "durableOperation"
    | "error"
    | "approvedBy"
    | "approvedAt"
    | "rejectedBy"
    | "rejectedAt"
    | "expiredAt"
    | "approvalNonce"
    | "approvalExpiresAt"
    | "worker"
    | "connectTarget"
    | "workerTerminalObservedAt"
  >
>

const updated = (
  record: JobRecord,
  now: number,
  change: JobChange
): JobRecord => ({ ...record, ...change, updatedAt: now })

export const makeFleetService = Effect.fn("FleetService.make")(function*(options: Options) {
  const cryptoService = yield* Crypto.Crypto
  const now = options.now ?? Clock.currentTimeMillis
  const randomError = (operation: string) => (cause: unknown) =>
    new FleetOperationError({ cause, detail: String(cause), operation })
  const id = options.id ??
    cryptoService.randomUUIDv4.pipe(Effect.mapError(randomError("fleet.job_id")))
  const nonce = options.nonce ??
    cryptoService.randomBytes(24).pipe(
      Effect.map(Encoding.encodeBase64Url),
      Effect.mapError(randomError("fleet.approval_nonce"))
    )
  const approvalTtlMs = options.approvalTtlMs ?? 15 * 60 * 1000

  const decodeActor = Effect.fn("FleetService.decodeActor")(function*(actor: string) {
    return yield* Schema.decodeUnknownEffect(JobActor)(actor).pipe(
      Effect.mapError(
        (cause) =>
          new FleetValidationError({
            detail: `invalid job actor: ${String(cause)}`
          })
      )
    )
  })

  const load = Effect.fn("FleetService.load")(function*(jobId: string) {
    const record = yield* options.store.get(jobId)
    if (record === undefined) {
      return yield* new FleetJobNotFoundError({ jobId })
    }
    return record
  })

  const expireApproval = Effect.fn("FleetService.expireApproval")(function*(
    record: JobRecord,
    timestamp: number
  ) {
    if (
      record.status !== "pending_approval" ||
      record.approvalExpiresAt === undefined ||
      record.approvalExpiresAt === null ||
      timestamp < record.approvalExpiresAt
    ) return record
    return yield* options.store.transition(
      record,
      updated(record, timestamp, {
        status: "expired",
        approvalNonce: null,
        approvalExpiresAt: null,
        expiredAt: timestamp,
        error: "approval expired"
      })
    ).pipe(
      Effect.catchTag("FleetTransitionConflictError", () => load(record.id))
    )
  })

  const get = Effect.fn("FleetService.get")(function*(jobId: string) {
    const record = yield* load(jobId)
    const timestamp = yield* now
    return yield* expireApproval(record, timestamp)
  })

  const submit = Effect.fn("FleetService.submit")(function*(
    request: JobRequest,
    actor: string
  ) {
    const validatedActor = yield* decodeActor(actor)
    const timestamp = yield* now
    const approval = requiresApproval(request.payload)
    if (approval && options.approvalEnabled === false) {
      return yield* new FleetValidationError({
        detail: "cross-host approval is disabled on this machine"
      })
    }
    const record: JobRecord = {
      id: yield* id,
      createdAt: timestamp,
      updatedAt: timestamp,
      actor: validatedActor,
      hash: yield* jobHash(options.host, validatedActor, request.payload).pipe(
        Effect.provideService(Crypto.Crypto, cryptoService)
      ),
      approvalNonce: approval ? yield* nonce : null,
      approvalExpiresAt: approval ? timestamp + approvalTtlMs : null,
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      expiredAt: null,
      status: approval ? "pending_approval" : "queued",
      payload: request.payload,
      result: null,
      acceptedReceipt: null,
      error: null
    }
    return yield* options.store.put(record)
  })

  const pendingApproval = Effect.fn("FleetService.pendingApproval")(function*(
    jobId: string,
    approval: Approval,
    timestamp: number
  ) {
    const record = yield* expireApproval(yield* load(jobId), timestamp)
    if (record.status !== "pending_approval") {
      return yield* new FleetApprovalError({
        jobId,
        detail: `job is ${record.status}, not pending approval`
      })
    }
    if (
      record.hash !== approval.hash ||
      record.approvalNonce !== approval.nonce
    ) {
      return yield* new FleetApprovalError({ jobId, detail: "job hash or nonce changed" })
    }
    return record
  })

  const approve = Effect.fn("FleetService.approve")(function*(
    jobId: string,
    approval: Approval,
    actor: string
  ) {
    const validatedActor = yield* decodeActor(actor)
    const timestamp = yield* now
    const record = yield* pendingApproval(jobId, approval, timestamp)
    return yield* options.store.transition(
      record,
      updated(record, timestamp, {
        status: "queued",
        approvedBy: validatedActor,
        approvedAt: timestamp,
        approvalNonce: null,
        approvalExpiresAt: null
      })
    )
  })

  const reject = Effect.fn("FleetService.reject")(function*(
    jobId: string,
    approval: Approval,
    actor: string
  ) {
    const validatedActor = yield* decodeActor(actor)
    const timestamp = yield* now
    const record = yield* pendingApproval(jobId, approval, timestamp)
    return yield* options.store.transition(
      record,
      updated(record, timestamp, {
        status: "rejected",
        rejectedBy: validatedActor,
        rejectedAt: timestamp,
        approvalNonce: null,
        approvalExpiresAt: null
      })
    )
  })

  const sameWorkerIdentity = (
    left: AgentWorkerIdentity,
    right: AgentWorkerIdentity
  ): boolean =>
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.agentId === right.agentId &&
    left.name === right.name &&
    left.paneId === right.paneId &&
    left.relationship?.parentAgentId === right.relationship?.parentAgentId &&
    left.relationship?.relation === right.relationship?.relation

  const makeOperationLifecycle = Effect.fn("FleetService.makeOperationLifecycle")(function*(
    initial: JobRecord,
    acceptedAtStart: boolean,
    recovering: boolean
  ) {
    const current = yield* Ref.make(initial)
    const accepted = yield* Ref.make(acceptedAtStart)
    const transitions = yield* Semaphore.make(1)
    const workerStarted: WorkerStarted = Effect.fn("FleetService.workerStarted")(
      (identity: AgentWorkerIdentity) =>
        transitions.withPermit(Effect.gen(function*() {
          const record = yield* Ref.get(current)
          if (record.status !== "running") {
            return yield* new FleetOperationError({
              cause: identity,
              detail: `cannot attach a worker to a ${record.status} fleet job`,
              operation: "fleet.worker_started"
            })
          }
          if (record.payload.kind !== "agent.delegate") {
            return yield* new FleetOperationError({
              cause: identity,
              detail: "only agent.delegate jobs can report a worker identity",
              operation: "fleet.worker_started"
            })
          }
          const coordinatorHandled = record.payload.mode === "consult" ||
            record.payload.channel === "coordinator_chat"
          if (!coordinatorHandled && identity.relationship === undefined) {
            return yield* new FleetOperationError({
              cause: identity,
              detail: "delegated worker identity is missing its exact relationship",
              operation: "fleet.worker_started"
            })
          }
          if (record.worker !== undefined) {
            if (recovering && sameWorkerIdentity(record.worker, identity)) return
            return yield* new FleetOperationError({
              cause: identity,
              detail: "coordinator reported more than one worker identity",
              operation: "fleet.worker_started"
            })
          }
          const persisted = yield* options.store.transition(
            record,
            updated(record, yield* now, {
              worker: identity,
              connectTarget: agentConnectTarget(identity),
              workerTerminalObservedAt: null
            })
          ).pipe(
            Effect.mapError(
              (cause) =>
                new FleetOperationError({
                  cause,
                  detail: "could not persist coordinator worker identity",
                  operation: "fleet.worker_started"
                })
            )
          )
          yield* Ref.set(current, persisted)
        }))
    )
    const lifecycle: HostOperationLifecycle = {
      accepted: Effect.fn("FleetService.operationAccepted")((receipt: string) =>
        transitions.withPermit(Effect.gen(function*() {
          const decodedReceipt = yield* Schema.decodeUnknownEffect(HostOperationReceipt)(receipt).pipe(
            Effect.mapError((cause) =>
              new FleetOperationError({
                cause,
                detail: "durable receipt is invalid",
                operation: "fleet.operation_accepted"
              })
            )
          )
          if (options.operations.recovery === undefined || initial.durableOperation !== true) {
            return yield* new FleetOperationError({
              cause: decodedReceipt,
              detail: "durable acceptance requires an explicit recovery operation",
              operation: "fleet.operation_accepted"
            })
          }
          if (yield* Ref.get(accepted)) {
            return yield* new FleetOperationError({
              cause: decodedReceipt,
              detail: "host operation reported more than one accepted receipt",
              operation: "fleet.operation_accepted"
            })
          }
          const record = yield* Ref.get(current)
          if (record.status !== "running") {
            return yield* new FleetOperationError({
              cause: decodedReceipt,
              detail: `cannot accept a ${record.status} fleet job`,
              operation: "fleet.operation_accepted"
            })
          }
          const persisted = yield* options.store.transition(
            record,
            updated(record, yield* now, {
              acceptedReceipt: decodedReceipt,
              result: decodedReceipt
            })
          ).pipe(Effect.mapError(randomError("fleet.operation_accepted")))
          yield* Ref.set(current, persisted)
          yield* Ref.set(accepted, true)
        }))
      ),
      terminal: Effect.fn("FleetService.operationTerminal")((event: HostOperationTerminal) =>
        transitions.withPermit(Effect.gen(function*() {
          const decodedEvent = yield* Schema.decodeUnknownEffect(HostOperationTerminal)(event).pipe(
            Effect.mapError((cause) =>
              new FleetOperationError({
                cause,
                detail: "durable terminal summary is invalid",
                operation: "fleet.operation_terminal"
              })
            )
          )
          if (!(yield* Ref.get(accepted))) {
            return yield* new FleetOperationError({
              cause: decodedEvent,
              detail: "host operation reported a terminal event before acceptance",
              operation: "fleet.operation_terminal"
            })
          }
          const record = yield* Ref.get(current)
          if (
            decodedEvent.type === "settled" &&
            decodedEvent.detail.length === 0 &&
            record.payload.kind === "agent.delegate" &&
            record.payload.channel === "coordinator_chat"
          ) {
            return yield* new FleetOperationError({
              cause: decodedEvent,
              detail: "coordinator chat settled without a reply",
              operation: "fleet.operation_terminal"
            })
          }
          if (record.status !== "running") {
            return yield* new FleetOperationError({
              cause: decodedEvent,
              detail: `cannot settle a ${record.status} fleet job`,
              operation: "fleet.operation_terminal"
            })
          }
          const terminalObservedAt = yield* now
          const terminal: JobChange = decodedEvent.type === "settled"
            ? { status: "succeeded", result: decodedEvent.detail, error: null }
            : { status: "failed", result: null, error: decodedEvent.detail }
          const persisted = yield* options.store.transition(
            record,
            updated(
              record,
              terminalObservedAt,
              record.worker === undefined
                ? terminal
                : { ...terminal, workerTerminalObservedAt: terminalObservedAt }
            )
          ).pipe(Effect.mapError(randomError("fleet.operation_terminal")))
          yield* Ref.set(current, persisted)
        }))
      )
    }
    return { accepted, current, lifecycle, transitions, workerStarted }
  })

  const runWith = Effect.fn("FleetService.runWith")(function*(
    jobId: string,
    execute: (
      payload: JobPayload,
      workerStarted: WorkerStarted,
      actor: JobActor,
      lifecycle: HostOperationLifecycle
    ) => Effect.Effect<
      string,
      FleetOperationError | FleetValidationError
    >
  ) {
    const record = yield* get(jobId)
    if (record.status !== "queued") {
      return yield* new FleetApprovalError({
        jobId,
        detail: `job is ${record.status}, not queued`
      })
    }
    const corePayload = record.payload.kind === "browser.mcp.recover" ? null : record.payload
    const durableOperation = corePayload !== null && options.operations.recovery?.matches(corePayload) === true
    const durableChange: JobChange = durableOperation ? { durableOperation: true } : {}
    const running = yield* options.store.transition(
      record,
      updated(record, yield* now, {
        status: "running",
        result: null,
        acceptedReceipt: null,
        ...durableChange,
        error: null
      })
    )
    const { accepted, current, lifecycle, transitions, workerStarted } = yield* makeOperationLifecycle(
      running,
      false,
      false
    )
    const result = yield* Effect.result(
      execute(running.payload, workerStarted, running.actor, lifecycle)
    )
    return yield* transitions.withPermit(Effect.gen(function*() {
      const latest = yield* Ref.get(current)
      if (yield* Ref.get(accepted)) {
        if (Result.isSuccess(result) || latest.status !== "running") return latest
        const persisted = yield* options.store.transition(
          latest,
          updated(latest, yield* now, {
            error: `accepted operation observer failed: ${result.failure.detail}`
          })
        )
        yield* Ref.set(current, persisted)
        return yield* result.failure
      }
      if (durableOperation && Result.isFailure(result)) {
        return yield* result.failure
      }
      if (durableOperation && Result.isSuccess(result)) {
        return yield* new FleetOperationError({
          cause: jobId,
          detail: "durable host operation returned without an accepted receipt",
          operation: "fleet.operation_acceptance_missing"
        })
      }
      if (latest.status !== "running") return latest
      const terminalObservedAt = yield* now
      if (Result.isSuccess(result)) {
        const succeeded: JobChange = latest.worker === undefined
          ? { status: "succeeded", result: result.success, error: null }
          : {
            status: "succeeded",
            result: result.success,
            error: null,
            workerTerminalObservedAt: terminalObservedAt
          }
        return yield* options.store.transition(
          latest,
          updated(latest, terminalObservedAt, succeeded)
        )
      }
      const failed: JobChange = latest.worker === undefined
        ? { status: "failed", result: null, error: result.failure.detail }
        : {
          status: "failed",
          result: null,
          error: result.failure.detail,
          workerTerminalObservedAt: terminalObservedAt
        }
      return yield* options.store.transition(
        latest,
        updated(latest, terminalObservedAt, failed)
      )
    }))
  })

  const run = Effect.fn("FleetService.run")((jobId: string) =>
    runWith(jobId, (payload, workerStarted, actor, lifecycle) =>
      payload.kind === "browser.mcp.recover"
        ? options.operations.runLocal(payload)
        : options.operations.run(payload, workerStarted, jobId, actor, lifecycle))
  )

  const runCoordinatorChat = Effect.fn("FleetService.runCoordinatorChat")(
    function*(jobId: string) {
      const record = yield* get(jobId)
      if (
        record.payload.kind !== "agent.delegate" ||
        record.payload.channel !== "coordinator_chat"
      ) {
        return yield* new FleetValidationError({
          detail: "coordinator chat job is not a channelled agent.delegate"
        })
      }
      return yield* runWith(
        jobId,
        (payload, workerStarted, actor, lifecycle) =>
          payload.kind === "agent.delegate" && payload.channel === "coordinator_chat"
            ? options.operations.runCoordinatorChat(payload, workerStarted, jobId, actor, lifecycle)
            : Effect.fail(
              new FleetValidationError({
                detail: "coordinator chat payload changed before execution"
              })
            )
      )
    }
  )

  const history = Effect.fn("FleetService.history")((limit: number) => options.store.list(limit))

  const historyAfter = Effect.fn("FleetService.historyAfter")((
    cursor: PendingApprovalCursor | null,
    limit: number
  ) => options.store.listHistory(cursor, limit))

  const historyPage = Effect.fn("FleetService.historyPage")(function*(
    cursor: PendingApprovalCursor | null,
    limit: number
  ) {
    const records: Array<JobRecord> = []
    let scannedCursor = cursor
    let hasMore = false
    scan: while (records.length < limit) {
      const requested = Math.min(9, limit - records.length + 1)
      const candidates = yield* options.store.listHistory(scannedCursor, requested)
      if (candidates.length === 0) break
      for (const candidate of candidates) {
        if (records.length >= limit) {
          hasMore = true
          break scan
        }
        const candidateCursor = { createdAt: candidate.createdAt, id: candidate.id }
        const bytes = new TextEncoder().encode(JSON.stringify({
          records: [...records, candidate],
          nextCursor: candidateCursor
        })).byteLength + 1
        if (bytes > fleetResponseBodyMaxBytes) {
          if (records.length === 0) {
            return yield* new FleetStoreError({
              cause: bytes,
              detail: "one job record cannot fit in a history response",
              operation: "historyPage"
            })
          }
          hasMore = true
          break scan
        }
        records.push(candidate)
        scannedCursor = candidateCursor
      }
      if (candidates.length < requested) break
    }
    return {
      records,
      nextCursor: hasMore && records.length > 0 ? scannedCursor : null
    }
  })

  const pendingApprovalPage = Effect.fn("FleetService.pendingApprovalPage")(
    function*(cursor: PendingApprovalCursor | null) {
      const scanned = yield* options.store.listPending(
        cursor,
        pendingApprovalPageMaxRecords + 1
      )
      const records = yield* Effect.forEach(
        scanned.slice(0, pendingApprovalPageMaxRecords),
        (record) => get(record.id)
      )
      const last = scanned[pendingApprovalPageMaxRecords - 1]
      return {
        records: records.filter((record) => record.status === "pending_approval"),
        nextCursor: scanned.length > pendingApprovalPageMaxRecords && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : null
      }
    }
  )

  const pendingApprovals = Effect.fn("FleetService.pendingApprovals")(
    function*() {
      const records: Array<JobRecord> = []
      let cursor: PendingApprovalCursor | null = null
      do {
        const page: {
          readonly records: ReadonlyArray<JobRecord>
          readonly nextCursor: PendingApprovalCursor | null
        } = yield* pendingApprovalPage(cursor)
        for (const record of page.records) records.push(record)
        cursor = page.nextCursor
      } while (cursor !== null)
      return records
    }
  )

  const status = Effect.fn("FleetService.status")(function*() {
    const state = yield* Effect.all({
      herdr: options.operations.listAgents(),
      details: options.operations.inspect()
    })
    return { host: options.host, ...state.details, herdr: state.herdr }
  })

  const agents = Effect.fn("FleetService.agents")(() => options.operations.listAgents())

  const workers = Effect.fn("FleetService.workers")(function*() {
    const records = yield* options.store.listWorkers(
      workerObservationMaxLength
    )
    const observations: Array<AgentWorkerObservation> = []
    for (const record of records) {
      if (record.worker !== undefined) {
        observations.push({
          ...record.worker,
          jobId: record.id,
          status: record.status,
          terminalObservedAt: record.workerTerminalObservedAt ?? null
        })
      }
    }
    return yield* Schema.decodeUnknownEffect(AgentWorkerObservations)(
      observations
    ).pipe(
      Effect.mapError(
        (cause) =>
          new FleetStoreError({
            cause,
            detail: "worker observation view exceeds its bound or is malformed",
            operation: "listWorkers.decode"
          })
      )
    )
  })

  const abortSubmission = Effect.fn("FleetService.abortSubmission")(function*(
    jobId: string,
    detail: string
  ) {
    const record = yield* get(jobId)
    if (record.status !== "queued" && record.status !== "pending_approval") {
      return yield* new FleetTransitionConflictError({ jobId })
    }
    return yield* options.store.transition(
      record,
      updated(record, yield* now, {
        status: "failed",
        approvalNonce: null,
        approvalExpiresAt: null,
        result: null,
        error: detail
      })
    )
  })

  const recover = Effect.fn("FleetService.recover")(function*() {
    const records = yield* options.store.listRecoverable()
    const queued: Array<string> = []
    for (const record of records) {
      if (record.status === "queued") queued.push(record.id)
      const timestamp = yield* now
      if (
        record.status === "pending_approval" &&
        record.approvalExpiresAt !== undefined &&
        record.approvalExpiresAt !== null &&
        timestamp >= record.approvalExpiresAt
      ) {
        yield* options.store.transition(
          record,
          updated(record, timestamp, {
            status: "expired",
            approvalNonce: null,
            approvalExpiresAt: null,
            expiredAt: timestamp,
            error: "approval expired while hostd was stopped"
          })
        )
      }
      if (record.status === "running") {
        const receipt = record.acceptedReceipt ?? null
        const durableOperation = record.durableOperation === true || receipt !== null
        if (durableOperation) {
          if (
            options.operations.recovery === undefined ||
            record.payload.kind === "browser.mcp.recover"
          ) {
            return yield* new FleetOperationError({
              cause: record.id,
              detail: "durable fleet job has no recovery operation",
              operation: "fleet.recover_durable"
            })
          }
          if (!options.operations.recovery.matches(record.payload)) {
            return yield* new FleetOperationError({
              cause: record.id,
              detail: "durable fleet job no longer matches its recovery operation",
              operation: "fleet.recover_durable"
            })
          }
          const resumed = yield* makeOperationLifecycle(record, receipt !== null, true)
          yield* options.operations.recovery.resume(
            record.payload,
            resumed.workerStarted,
            record.id,
            record.actor,
            receipt,
            resumed.lifecycle,
            record.worker ?? null
          )
          continue
        }
        const terminalObservedAt = yield* now
        const failure: JobChange = record.worker === undefined
          ? {
            status: "interrupted",
            result: null,
            error: "hostd restarted while this job was running"
          }
          : {
            status: "interrupted",
            result: null,
            error: "hostd restarted while this job was running",
            workerTerminalObservedAt: terminalObservedAt
          }
        yield* options.store.transition(
          record,
          updated(record, terminalObservedAt, failure)
        )
      }
    }
    return queued
  })

  return {
    submit,
    approve,
    reject,
    run,
    runCoordinatorChat,
    get,
    history,
    historyAfter,
    historyPage,
    pendingApprovalPage,
    pendingApprovals,
    agents,
    workers,
    status,
    recover,
    abortSubmission
  }
})

export type FleetService = Effect.Success<ReturnType<typeof makeFleetService>>
