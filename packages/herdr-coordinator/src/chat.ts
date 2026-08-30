import type { FleetService, HostConfiguration, JobRecord } from "@knpkv/herdr-fleet"
import { Clock, Crypto, Effect, Result, Schema } from "effect"
import { ChatHistoryError } from "./errors.js"
import { type ChatEntry, type ChatHistory, type ChatRequest, CoordinatorReply, type StoredChatTurn } from "./model.js"
import type { ChatStoreService } from "./store.js"

export interface CoordinatorChatOptions {
  readonly config: HostConfiguration
  readonly fleet: FleetService
  readonly now?: Effect.Effect<number>
  readonly nextId?: Effect.Effect<string>
  readonly store: ChatStoreService
}

const historyError = (operation: string) => (cause: unknown) =>
  new ChatHistoryError({ cause, detail: String(cause), operation })

const stateOf = (record: JobRecord): ChatEntry["state"] => {
  switch (record.status) {
    case "pending_approval":
    case "queued":
      return "pending"
    case "running":
      return "running"
    case "succeeded":
      return "completed"
    case "expired":
    case "failed":
    case "rejected":
      return "failed"
    case "interrupted":
      return "interrupted"
  }
}

const entryFor = Effect.fn("CoordinatorChat.entryFor")(function*(
  turn: StoredChatTurn,
  record: JobRecord
) {
  const state = stateOf(record)
  const reply = state === "completed"
    ? yield* Schema.decodeUnknownEffect(CoordinatorReply)(record.result).pipe(
      Effect.mapError(historyError("chat.reply.decode"))
    )
    : null
  const entry = {
    createdAt: turn.createdAt,
    id: turn.id,
    message: turn.message,
    mode: turn.mode,
    reply,
    state,
    updatedAt: record.updatedAt
  }
  if (record.worker === undefined) return entry satisfies ChatEntry
  if (record.connectTarget === undefined) {
    return yield* new ChatHistoryError({
      cause: record,
      detail: "started coordinator worker is missing its exact Connect target",
      operation: "chat.worker_target"
    })
  }
  return {
    ...entry,
    worker: record.worker,
    connectTarget: record.connectTarget
  } satisfies ChatEntry
})

export const makeCoordinatorChat = Effect.fn("CoordinatorChat.make")(function*(
  options: CoordinatorChatOptions
) {
  const cryptoService = yield* Crypto.Crypto
  const nextId = options.nextId ??
    cryptoService.randomUUIDv4.pipe(Effect.mapError(historyError("chat.id")))
  const now = options.now ?? Clock.currentTimeMillis

  const submit = Effect.fn("CoordinatorChat.submit")(function*(
    request: ChatRequest,
    actor: string
  ) {
    const record = yield* options.fleet.submit(
      {
        payload: {
          kind: "agent.delegate",
          channel: "coordinator_chat",
          mode: request.mode === "ask" ? "consult" : "work",
          prompt: request.message,
          repository: options.config.repository
        }
      },
      actor
    )
    const persisted = yield* Effect.result(options.store.put({
      createdAt: yield* now,
      id: yield* nextId,
      jobId: record.id,
      message: request.message,
      mode: request.mode
    }))
    if (Result.isFailure(persisted)) {
      const compensated = yield* Effect.result(
        options.fleet.abortSubmission(
          record.id,
          "coordinator chat turn was not persisted"
        )
      )
      if (Result.isFailure(compensated)) {
        return yield* new ChatHistoryError({
          cause: {
            compensation: compensated.failure,
            persistence: persisted.failure
          },
          detail: "chat persistence failed and the fleet job could not be aborted",
          operation: "chat.submit.compensate"
        })
      }
      return yield* persisted.failure
    }
    const turn = persisted.success
    return {
      entry: yield* entryFor(turn, record),
      jobId: record.id,
      queued: record.status === "queued"
    }
  })

  const history = Effect.fn("CoordinatorChat.history")(function*() {
    const turns = yield* options.store.list()
    const entries = yield* Effect.forEach(
      turns,
      (turn) => options.fleet.get(turn.jobId).pipe(Effect.flatMap((record) => entryFor(turn, record)))
    )
    return { entries } satisfies ChatHistory
  })

  const run = Effect.fn("CoordinatorChat.run")(function*(jobId: string) {
    const turn = yield* options.store.getByJob(jobId)
    if (turn === undefined) {
      const aborted = yield* Effect.result(
        options.fleet.abortSubmission(
          jobId,
          "coordinator chat turn is missing"
        )
      )
      return yield* new ChatHistoryError({
        cause: Result.isFailure(aborted) ? aborted.failure : jobId,
        detail: Result.isFailure(aborted)
          ? "coordinator chat turn is missing and its fleet job could not be aborted"
          : "coordinator chat turn is missing; its fleet job was aborted",
        operation: "chat.run.lookup"
      })
    }
    return yield* options.fleet.runCoordinatorChat(jobId)
  })

  return { history, run, submit }
})

export type CoordinatorChat = Effect.Success<ReturnType<typeof makeCoordinatorChat>>
