/**
 * The Relay harness: one durable session per product object, a model turn on the user's own CLI login,
 * capabilities behind one permission gate, and one event stream for the dock.
 *
 * **Mental model**
 *
 * - **Pi Durable owns the loop and the store.** Every input, model turn and tool call is committed
 *   before it is shown; a process killed mid-run continues from its last checkpoint on the next start,
 *   and a write that was interrupted is never repeated.
 * - **This service is the only door.** Products and the dock call {@link RelayHarnessService}; nothing
 *   outside this package imports Pi. Replacing Pi with an Effect-native store changes this module only.
 * - **One process owns a store.** The SQLite connection runs in exclusive locking mode, so a second
 *   process fails to open the same store with {@link RelayStoreLocked}, and the OS releases the lock if
 *   the owner dies, even on `kill -9`.
 * - **A run is named by the `requestId`s it answers.** `send` takes the dock's `requestId`; events that
 *   end a run, and the Snapshot of a run in flight, list them, and `cancel` stops a run only by one of them.
 * - **Backend status is observed, not assumed.** A backend starts `Unverified` when its CLI answers
 *   `--version`, turns `Ready` when a turn answers, and `Unavailable` with `SignedOut` when the CLI refuses
 *   the login. Nothing about it is persisted.
 *
 * @module
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Message } from "@earendil-works/pi-ai"
import { createRegistry, defineDoc, Harness, watchEvents } from "@earendil-works/pi-durable"
import type {
  AgentEvent,
  Conversation,
  ConversationId,
  SubmissionId,
  SubmissionRecord
} from "@earendil-works/pi-durable"
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite"
import * as Capability from "@knpkv/capability"
import { createClient } from "@libsql/client"
import {
  Clock,
  Context,
  Crypto,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Predicate,
  PubSub,
  Queue,
  Ref,
  Schema,
  Semaphore,
  Stream
} from "effect"
import { AiError } from "effect/ai"
import type { LanguageModel } from "effect/ai"
import type { PlatformError } from "effect/PlatformError"
import { libsqlDatabase } from "./libsqlDatabase.js"
import { BackendUnavailableCause, DecisionState, objectRefKey, RelayBackendId } from "./model.js"
import type { BackendStatus, ObjectRef, RelayEvent, SessionInfo, SessionTool } from "./model.js"
import { relayModels, relayProvider } from "./piProvider.js"
import type { TurnRunner } from "./piProvider.js"
import { relayExtension } from "./piTools.js"
import type { ConfirmationBroker, EffectRunner } from "./piTools.js"
import type { RegisteredCapability } from "./registry.js"
import { runTurn } from "./turn.js"

/** Another process already owns this Relay store. */
export class RelayStoreLocked extends Schema.TaggedError<RelayStoreLocked>()("RelayStoreLocked", {
  path: Schema.String,
  message: Schema.String
}) {}

/** The Relay store could not be opened or read. `message` names the operation and the fix. */
export class RelayStoreFailed extends Schema.TaggedError<RelayStoreFailed>()("RelayStoreFailed", {
  operation: Schema.String,
  message: Schema.String
}) {}

/** No confirmation is waiting for this call; `state` says whether it was answered, withdrawn, or never asked. */
export class RelayDecisionNotPending extends Schema.TaggedError<RelayDecisionNotPending>()(
  "RelayDecisionNotPending",
  { callId: Schema.String, state: DecisionState }
) {}

/** No run of this session answers `runId`: it finished, or never started. */
export class RelayRunNotActive extends Schema.TaggedError<RelayRunNotActive>()("RelayRunNotActive", {
  runId: Schema.String
}) {}

/** The session asked for a backend this product did not configure. */
export class RelayBackendNotConfigured extends Schema.TaggedError<RelayBackendNotConfigured>()(
  "RelayBackendNotConfigured",
  { backend: RelayBackendId }
) {}

/** A backend's CLI can't be used. `fix` is the one action that makes it usable. */
export class RelayBackendUnavailable extends Schema.TaggedError<RelayBackendUnavailable>()(
  "RelayBackendUnavailable",
  { cause: BackendUnavailableCause, fix: Schema.String }
) {}

/** One backend the harness can run turns on, with the `LanguageModel` that reaches it. */
export interface RelayBackend {
  readonly id: RelayBackendId
  readonly name: string
  readonly model: Layer.Layer<LanguageModel.LanguageModel>
  /** The CLI's version, read without a model call; fails when it is missing or unusable. */
  readonly probe: Effect.Effect<string, RelayBackendUnavailable>
  /** The one line that signs the CLI back in, shown when a turn is refused for its login. */
  readonly signInFix: string
}

export interface RelayHarnessOptions<Requirements> {
  /** SQLite file of this product's Relay sessions. Owner-only; never on a shared path. */
  readonly storePath: string
  /** The product's standing instructions for Relay. */
  readonly instructions: string
  readonly capabilities: ReadonlyArray<RegisteredCapability<Requirements>>
  /** The first backend is the default for new sessions. */
  readonly backends: readonly [RelayBackend, ...ReadonlyArray<RelayBackend>]
}

export interface RelayHarnessService {
  /**
   * Send a message to the session about `ref`. `requestId` makes a retried send land once and names the run
   * that answers it. `backend` switches the session to that backend from its next turn on.
   */
  readonly send: (
    ref: ObjectRef,
    text: string,
    requestId: string,
    backend?: RelayBackendId
  ) => Effect.Effect<void, RelayStoreFailed | RelayBackendNotConfigured>
  /** The session's events: a `Snapshot` first, then every change. Ends when the scope closes. */
  readonly events: (ref: ObjectRef) => Stream.Stream<RelayEvent, RelayStoreFailed>
  /** Answer a pending confirmation. Outcomes are remembered for the harness's lifetime, not across restarts. */
  readonly decide: (callId: string, allow: boolean) => Effect.Effect<void, RelayDecisionNotPending>
  /**
   * Stop the run answering `runId`. A message still queued is withdrawn alone; a run in flight stops whole,
   * with every message it took. Nothing already committed is undone.
   */
  readonly cancel: (ref: ObjectRef, runId: string) => Effect.Effect<void, RelayStoreFailed | RelayRunNotActive>
  /** The tools the dock lists for a session, and the backend its next turn runs on. */
  readonly session: (ref: ObjectRef) => Effect.Effect<SessionInfo, RelayStoreFailed>
  /** Every configured backend's status, in configuration order. */
  readonly backends: Effect.Effect<ReadonlyArray<BackendStatus>>
  /** The tools the dock lists for a session. */
  readonly tools: ReadonlyArray<SessionTool>
}

export class RelayHarness extends Context.Service<RelayHarness, RelayHarnessService>()("@knpkv/relay/RelayHarness") {}

/** Which conversation is about which object. Lives on the root conversation. */
const SessionIndex = defineDoc<{ readonly sessions: Record<string, ConversationId> }>({
  kind: "relay.sessions",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ sessions: {} })
})

const promise = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RelayStoreFailed({ operation, message: `${operation} failed: ${String(cause)}` })
  })

const openStore = (path: string) =>
  Effect.acquireRelease(
    Effect.gen(function*() {
      // Sessions hold conversation content: the directory and the database are owner-only.
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const ownerOnly = (operation: string) =>
        Effect.mapError((cause: PlatformError) =>
          new RelayStoreFailed({ operation, message: `${operation} failed: ${cause.message}` })
        )
      yield* fs.makeDirectory(paths.dirname(path), { recursive: true, mode: 0o700 }).pipe(
        ownerOnly("create the Relay store directory")
      )
      yield* fs.chmod(paths.dirname(path), 0o700).pipe(ownerOnly("restrict the Relay store directory"))
      const client = createClient({ url: `file:${path}` })
      const database = libsqlDatabase(client)
      yield* promise("open the Relay store", async () => {
        // Exclusive locking: the first write takes a lock this connection keeps until it closes or dies.
        await database.exec("PRAGMA locking_mode = EXCLUSIVE")
        await database.exec("PRAGMA journal_mode = WAL")
        await database.exec("PRAGMA synchronous = NORMAL")
        await database.exec("BEGIN IMMEDIATE; COMMIT")
      }).pipe(
        Effect.andThen(fs.chmod(path, 0o600).pipe(ownerOnly("restrict the Relay store"))),
        Effect.catchTag("RelayStoreFailed", (failure): Effect.Effect<never, RelayStoreFailed | RelayStoreLocked> =>
          /SQLITE_BUSY|database is locked/u.test(failure.message)
            ? Effect.fail(
              new RelayStoreLocked({
                path,
                message: `Another process owns the Relay store at ${path}. Stop it, then retry.`
              })
            )
            : Effect.fail(failure))
      )
      return database
    }),
    (database) =>
      Effect.promise(() =>
        database.close()
      )
  )

/** Build the harness for one product. */
export const make = Effect.fn("RelayHarness.make")(function*<Requirements>(options: RelayHarnessOptions<Requirements>) {
  const services = yield* Effect.context<Requirements>()
  const runEffect: EffectRunner<Requirements> = (effect, signal) =>
    Effect.runPromiseExitWith(services)(effect, signal === undefined ? undefined : { signal })
  const runPromise = Effect.runPromiseWith(services)
  const cryptoService = yield* Crypto.Crypto
  // Pi sleeps until `now()` reaches persisted deadlines (retry backoff, deferred polls), so it reads the
  // live clock on every call, never a cached value.
  const clockService = yield* Clock.Clock
  const now = () => clockService.currentTimeMillisUnsafe()

  const probed = (backend: RelayBackend): Effect.Effect<BackendStatus> =>
    backend.probe.pipe(
      Effect.match({
        onSuccess: (version): BackendStatus => ({
          _tag: "Unverified",
          backend: backend.id,
          label: backend.name,
          version
        }),
        onFailure: (failure): BackendStatus => ({
          _tag: "Unavailable",
          backend: backend.id,
          label: backend.name,
          cause: failure.cause,
          fix: failure.fix
        })
      })
    )
  const statuses = yield* Ref.make<ReadonlyArray<BackendStatus>>(
    yield* Effect.forEach(options.backends, probed, { concurrency: "unbounded" })
  )
  const setStatus = (status: BackendStatus) =>
    Ref.update(statuses, (all) => all.map((current) => (current.backend === status.backend ? status : current)))
  const statusOf = (backend: RelayBackend) =>
    Effect.map(Ref.get(statuses), (all) => all.find((status) => status.backend === backend.id))
  // A turn that answered proves the CLI works. One refused for its login is the only failure that says
  // something about the backend rather than the request; the rest stay on the run.
  const observed = (backend: RelayBackend, exit: Exit.Exit<unknown, unknown>) =>
    Effect.gen(function*() {
      const current = yield* statusOf(backend)
      const version = current?.version
      if (Exit.isSuccess(exit)) {
        if (version !== undefined) {
          return yield* setStatus({ _tag: "Ready", backend: backend.id, label: backend.name, version })
        }
        const reprobed = yield* probed(backend)
        return yield* setStatus(
          reprobed._tag === "Unverified" ? { ...reprobed, _tag: "Ready" } : reprobed
        )
      }
      const error = Exit.findErrorOption(exit)
      if (
        error._tag === "Some" && AiError.isAiError(error.value) && error.value.reason._tag === "AuthenticationError"
      ) {
        yield* setStatus({
          _tag: "Unavailable",
          backend: backend.id,
          label: backend.name,
          ...(version !== undefined && { version }),
          cause: "SignedOut",
          fix: backend.signInFix
        })
      }
    })

  // Each backend's model is built once, with the harness, and reused by every turn.
  const providers = yield* Effect.forEach(
    options.backends,
    (backend) =>
      Effect.map(Layer.build(backend.model), (modelContext) => {
        const runner: TurnRunner = (request, signal) =>
          runPromise(
            Effect.gen(function*() {
              const turn = yield* runTurn(request).pipe(Effect.provideContext(modelContext))
              const callIds = yield* Effect.forEach(turn.toolCalls, () => cryptoService.randomUUIDv4)
              return { turn, callIds }
            }).pipe(Effect.onExit((exit) => observed(backend, exit))),
            signal === undefined ? undefined : { signal }
          )
        return relayProvider(backend.id, backend.name, runner, now)
      })
  )
  const models = relayModels(providers)

  // Confirmations waiting for a person, with the event that shows them, so a dock that reconnects
  // mid-confirmation sees the card again after its Snapshot.
  const pending = new Map<string, { readonly decision: Deferred.Deferred<boolean>; readonly event: Unsequenced }>()
  // How each confirmation this process asked for ended, so a late or repeated answer learns why it is refused.
  const outcomes = new Map<string, DecisionState>()
  const pendingFor = (session: string): ReadonlyArray<Unsequenced> =>
    [...pending.values()].flatMap(({ event }) => (event.session === session ? [event] : []))
  const confirmations = yield* PubSub.unbounded<{ readonly conversationId: string; readonly event: Unsequenced }>()
  const broker: ConfirmationBroker = {
    ask: (request, signal) =>
      runPromise(
        Effect.gen(function*() {
          const decision = yield* Deferred.make<boolean>()
          const event: Unsequenced = {
            _tag: "ConfirmationRequired",
            session: request.conversationId,
            call: request.callId,
            action: request.action,
            reversible: request.reversible
          }
          pending.set(request.callId, { decision, event })
          yield* PubSub.publish(confirmations, { conversationId: request.conversationId, event })
          return yield* Deferred.await(decision)
        }).pipe(
          // A cancelled run aborts the call: the card goes away with it, answered or not.
          Effect.ensuring(Effect.sync(() => {
            pending.delete(request.callId)
            if (!outcomes.has(request.callId)) outcomes.set(request.callId, { _tag: "Expired" })
          }))
        ),
        signal === undefined ? undefined : { signal }
      )
  }

  const registry = createRegistry()
  registry.install(relayExtension(options.capabilities, runEffect, broker))
  const database = yield* openStore(options.storePath)
  const storage = yield* promise("read the Relay store", () => SqliteStorage.open(database))
  const harness = yield* Effect.acquireRelease(
    promise(
      "start the Relay harness",
      () => Harness.open(storage, { models, registry, now }, BACKGROUND_CONTEXT)
    ),
    (opened) => Effect.promise(() => opened.close(BACKGROUND_CONTEXT))
  )
  const defaultBackend = options.backends[0].id
  const root = yield* promise(
    "open the Relay index",
    () => harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: defaultBackend, modelId: "default" } } })
  )
  harness.resume()

  // One process owns the store, so one lock here is enough to create each object's session once.
  const sessionLock = yield* Semaphore.make(1)
  const conversationFor = (ref: ObjectRef): Effect.Effect<Conversation, RelayStoreFailed> =>
    sessionLock.withPermits(1)(promise("open the session", async () => {
      const key = objectRefKey(ref)
      const index = await harness.snapshot(SessionIndex, root.id, BACKGROUND_CONTEXT)
      const known = index?.sessions[key]
      if (known !== undefined) {
        const existing = await harness.conversation(known, BACKGROUND_CONTEXT)
        if (existing !== undefined) return existing
      }
      const created = await harness.createConversation({
        ownership: { kind: "ownerless" },
        agent: { model: { provider: defaultBackend, modelId: "default" }, instructions: options.instructions }
      }, BACKGROUND_CONTEXT)
      await root.commit(async (tx) => {
        const sessions = await tx.doc(SessionIndex, root.id)
        sessions.sessions[key] = created.id
      }, BACKGROUND_CONTEXT)
      return created
    }))

  const tools = options.capabilities.map((capability): SessionTool => ({
    name: capability.name,
    access: capability.gate?.access ?? "read",
    available: true
  }))

  return RelayHarness.of({
    tools,
    send: (ref, text, requestId, backend) =>
      Effect.gen(function*() {
        if (backend !== undefined && !options.backends.some((configured) => configured.id === backend)) {
          return yield* new RelayBackendNotConfigured({ backend })
        }
        const conversation = yield* conversationFor(ref)
        if (backend !== undefined) {
          yield* promise("switch the backend", () =>
            conversation.configure({ model: { provider: backend, modelId: "default" } }, BACKGROUND_CONTEXT))
        }
        yield* promise("send the message", () =>
          conversation.submit({ type: "input", content: text, requestId }, BACKGROUND_CONTEXT))
      }),
    events: (ref) =>
      Stream.unwrap(
        Effect.map(conversationFor(ref), (conversation) =>
          sessionEvents(harness, conversation, confirmations, pendingFor))
      ),
    decide: (callId, allow) =>
      Effect.gen(function*() {
        const waiting = pending.get(callId)
        if (waiting === undefined) {
          return yield* new RelayDecisionNotPending({ callId, state: outcomes.get(callId) ?? { _tag: "Unknown" } })
        }
        outcomes.set(callId, { _tag: "Decided", allow })
        pending.delete(callId)
        yield* Deferred.succeed(waiting.decision, allow)
      }),
    cancel: (ref, runId) =>
      Effect.gen(function*() {
        const conversation = yield* conversationFor(ref)
        const submission = yield* promise(
          "find the run",
          () => storage.submissionByRequest(conversation.id, runId, BACKGROUND_CONTEXT)
        )
        if (submission?.type !== "input") return yield* new RelayRunNotActive({ runId })
        if (submission.status === "queued") {
          const withdrawn = yield* promise(
            "withdraw the message",
            () => harness.abortSubmission(submission.id, BACKGROUND_CONTEXT, conversation.id)
          )
          // Placed between the read and the withdrawal: it is the run in flight now.
          if (withdrawn !== "already_placed") return
        } else if (submission.status !== "placed") {
          return yield* new RelayRunNotActive({ runId })
        }
        yield* promise("cancel the run", () => conversation.abort(BACKGROUND_CONTEXT))
      }),
    session: (ref) =>
      Effect.gen(function*() {
        const conversation = yield* conversationFor(ref)
        const agent = yield* promise("read the session", () => conversation.agent(BACKGROUND_CONTEXT))
        const backend = Schema.decodeUnknownOption(RelayBackendId)(agent.model?.provider)
        return { tools, backend: backend._tag === "Some" ? backend.value : defaultBackend }
      }),
    backends: Ref.get(statuses)
  })
})

/** Build the harness as a scoped layer: the store closes, and the lock is released, with the scope. */
export const layer = <Requirements>(options: RelayHarnessOptions<Requirements>) =>
  Layer.effect(RelayHarness, make(options))

/** The visible text of a stored user or assistant entry. */
const entryText = (messages: ReadonlyArray<Message> | undefined): string =>
  (messages ?? [])
    .flatMap((message) =>
      message.role === "user" || message.role === "assistant"
        ? Predicate.isString(message.content)
          ? [message.content]
          : message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
        : []
    )
    .join("\n")

/** The citations a capability call records in its Pi tool details. */
const decodeCites = Schema.decodeUnknownOption(Schema.Struct({ cites: Schema.Array(Capability.ObjectRef) }))

/** A Relay event before the stream numbers it. */
type Unsequenced = RelayEvent extends infer Event ? Event extends RelayEvent ? Omit<Event, "seq"> : never : never

const sessionEvents = (
  harness: Harness,
  conversation: Conversation,
  confirmations: PubSub.PubSub<{ readonly conversationId: string; readonly event: Unsequenced }>,
  pendingFor: (session: string) => ReadonlyArray<Unsequenced>
): Stream.Stream<RelayEvent, RelayStoreFailed> => {
  const session = String(conversation.id)
  const fromPi = Stream.callback<AgentEvent, RelayStoreFailed>((queue) =>
    Effect.acquireRelease(
      promise("watch the session", async () => {
        const watch = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT)
        Queue.offerUnsafe(queue, watch.snapshot)
        watch.start(async (events) => {
          for (const event of events) Queue.offerUnsafe(queue, event)
        })
        return watch
      }),
      (watch) => Effect.promise(() => watch.stop())
    )
  )
  const cites = new Map<string, ReadonlyArray<Capability.ObjectRef>>()
  // Text already shown per content block of the in-flight message, so each change emits only what's new.
  const sent = new Map<number, string>()
  const textFrom = (index: number, full: string): ReadonlyArray<Unsequenced> => {
    const before = sent.get(index) ?? ""
    sent.set(index, full)
    return full.length > before.length && full.startsWith(before)
      ? [{ _tag: "TextDelta", session, text: full.slice(before.length) }]
      : []
  }
  // A dock that attaches mid-run sees the run as it stands: the partial answer so far, then the tools
  // still running, with their arguments from the call that started them.
  const inFlight = (snapshot: Extract<AgentEvent, { readonly type: "snapshot" }>): ReadonlyArray<Unsequenced> => {
    const calls = new Map<string, Schema.Json>()
    for (const entry of snapshot.entries) {
      for (const message of entry.model ?? []) {
        if (message.role !== "assistant") continue
        for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, block.arguments)
      }
    }
    const partial =
      snapshot.generation?.message?.content.flatMap((block, index) =>
        block.type === "text" ? textFrom(index, block.text) : []
      ) ?? []
    const running = snapshot.tools.flatMap((slot): ReadonlyArray<Unsequenced> =>
      slot.status === "done"
        ? []
        : [{
          _tag: "ToolStarted",
          session,
          call: slot.callId,
          capability: slot.name,
          input: calls.get(slot.callId) ?? {}
        }]
    )
    return [...partial, ...running]
  }
  const toRelay = (event: AgentEvent, runIds: ReadonlyArray<string>): ReadonlyArray<Unsequenced> => {
    switch (event.type) {
      case "snapshot":
        return [
          {
            _tag: "Snapshot",
            session,
            runIds,
            messages: event.entries.flatMap((
              entry
            ): ReadonlyArray<{ readonly role: "user" | "relay"; readonly text: string }> =>
              entry.kind === "pi.user"
                ? [{ role: "user", text: entryText(entry.model) }]
                : entry.kind === "pi.assistant"
                ? [{ role: "relay", text: entryText(entry.model) }]
                : []
            )
          },
          ...inFlight(event),
          ...pendingFor(session)
        ]
      case "message_start":
        sent.clear()
        // A turn that finished before its first commit arrives whole here, with no updates after it.
        return event.message.role === "assistant"
          ? event.message.content.flatMap((block, index) => (block.type === "text" ? textFrom(index, block.text) : []))
          : []
      case "message_update":
        return event.changes.flatMap((change): ReadonlyArray<Unsequenced> => {
          // Pi coalesces commits, so text arrives as deltas, as a whole block, or as the whole message.
          if (change.type === "text_delta") {
            return textFrom(change.contentIndex, (sent.get(change.contentIndex) ?? "") + change.delta)
          }
          if (change.type === "block") {
            return change.block.type === "text"
              ? textFrom(change.contentIndex, change.block.text)
              : []
          }
          if (change.type === "message") {
            return change.message.content.flatMap((
              block,
              index
            ) => (block.type === "text" ? textFrom(index, block.text) : []))
          }
          return []
        })
      case "tool_execution_start":
        return [{ _tag: "ToolStarted", session, call: event.toolCallId, capability: event.toolName, input: event.args }]
      case "tool_execution_update": {
        const decoded = decodeCites(event.details)
        if (decoded._tag === "Some") cites.set(event.toolCallId, decoded.value.cites)
        return []
      }
      case "tool_execution_end": {
        const cited = cites.get(event.toolCallId) ?? []
        cites.delete(event.toolCallId)
        // Pi writes a result entry for blocked, declined, failed and interrupted calls too; only a result
        // that is not an error is a success.
        const failed = (event.entry?.model ?? []).some((message) =>
          message.role === "toolResult" && message.isError === true
        )
        return [{
          _tag: "ToolFinished",
          session,
          call: event.toolCallId,
          ok: event.entry !== undefined && !failed,
          cites: cited
        }]
      }
      case "task_failed":
        return [{
          _tag: "RunFailed",
          session,
          runIds,
          cause: "The run stopped on an error",
          fix: "Retry the message; if it fails again, check the backend in setup."
        }]
      default:
        return []
    }
  }
  const records = (inputs: ReadonlyArray<SubmissionId>) =>
    Promise.all(
      inputs.map(async (id) => (await harness.submission(id, BACKGROUND_CONTEXT))?.status(BACKGROUND_CONTEXT))
    )
  // Every input Relay submits carries the dock's requestId; an id is the fallback for one that doesn't.
  const runIdsOf = (inputs: ReadonlyArray<SubmissionId>, read: ReadonlyArray<SubmissionRecord | undefined>) =>
    inputs.map((id, index) => read[index]?.requestId ?? String(id))
  // The run in flight as this subscription last saw it: the Snapshot names it, so a cancel can address it.
  let active: ReadonlyArray<string> = []
  const track = (inputs: ReadonlyArray<SubmissionId>): Effect.Effect<ReadonlyArray<string>, RelayStoreFailed> =>
    (inputs.length === 0
      ? Effect.succeed([])
      : promise("read the run in flight", async () => runIdsOf(inputs, await records(inputs)))).pipe(
        Effect.tap((runIds) => Effect.sync(() => (active = runIds)))
      )
  // A run's end says only which inputs it ran; each input's submission record says how it ended.
  const runEnded = (inputs: ReadonlyArray<SubmissionId>): Effect.Effect<Unsequenced, RelayStoreFailed> =>
    promise("read how the run ended", async () => {
      const read = await records(inputs)
      const runIds = runIdsOf(inputs, read)
      const unanswered = read.find((record) => record?.status === "unanswered")
      if (unanswered === undefined || unanswered.status !== "unanswered") {
        return { _tag: "RunFinished", session, runIds }
      }
      // An abort is the person's cancellation; any other reason is a failure the dock must explain.
      return /abort/iu.test(unanswered.reason)
        ? { _tag: "Cancelled", session, runIds }
        : {
          _tag: "RunFailed",
          session,
          runIds,
          // `reason` is Pi's code (`model_error`); `detail` carries the backend's own message when there is one.
          cause: Predicate.isString(unanswered.detail) ? unanswered.detail : unanswered.reason,
          fix: "Check the backend in Relay setup (installed and signed in), then send the message again."
        }
    })
  const gate = Stream.fromPubSub(confirmations).pipe(
    Stream.filter(({ conversationId }) => conversationId === session),
    Stream.map(({ event }) => event)
  )
  let seq = 0
  const relayed = Stream.flatMap(
    fromPi,
    (event) =>
      event.type === "run_end"
        ? Stream.fromEffect(runEnded(event.inputs).pipe(Effect.tap(() => Effect.sync(() => (active = [])))))
        : event.type === "run_start"
        ? Stream.fromEffect(track(event.inputs)).pipe(Stream.drain)
        : event.type === "snapshot"
        ? Stream.fromEffect(track(event.run?.inputs ?? [])).pipe(
          Stream.flatMap((runIds) => Stream.fromIterable(toRelay(event, runIds)))
        )
        : Stream.fromIterable(toRelay(event, active))
  )
  return Stream.merge(relayed, gate).pipe(
    Stream.map((event): RelayEvent => ({ ...event, seq: seq++ }))
  )
}
