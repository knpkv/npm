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
 *
 * @module
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Message } from "@earendil-works/pi-ai"
import { createRegistry, defineDoc, Harness, watchEvents } from "@earendil-works/pi-durable"
import type { AgentEvent, Conversation, ConversationId } from "@earendil-works/pi-durable"
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite"
import { createClient } from "@libsql/client"
import {
  Clock,
  Context,
  Crypto,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Path,
  Predicate,
  PubSub,
  Queue,
  Schema,
  Semaphore,
  Stream
} from "effect"
import type { LanguageModel } from "effect/ai"
import type { PlatformError } from "effect/PlatformError"
import { libsqlDatabase } from "./libsqlDatabase.js"
import { ObjectRef, objectRefKey } from "./model.js"
import type { RelayBackendId, RelayEvent, SessionTool } from "./model.js"
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

/** No confirmation is waiting for this call: it was already decided, or belongs to another session. */
export class RelayDecisionNotPending extends Schema.TaggedError<RelayDecisionNotPending>()(
  "RelayDecisionNotPending",
  { callId: Schema.String }
) {}

/** One backend the harness can run turns on, with the `LanguageModel` that reaches it. */
export interface RelayBackend {
  readonly id: RelayBackendId
  readonly name: string
  readonly model: Layer.Layer<LanguageModel.LanguageModel>
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
  /** Send a message to the session about `ref`. `requestId` makes a retried send land once. */
  readonly send: (
    ref: ObjectRef,
    text: string,
    requestId: string
  ) => Effect.Effect<void, RelayStoreFailed>
  /** The session's events: a `Snapshot` first, then every change. Ends when the scope closes. */
  readonly events: (ref: ObjectRef) => Stream.Stream<RelayEvent, RelayStoreFailed>
  /** Answer a pending confirmation. */
  readonly decide: (callId: string, allow: boolean) => Effect.Effect<void, RelayDecisionNotPending>
  /** Stop the session's current run. Queued inputs are withdrawn; nothing already committed is undone. */
  readonly cancel: (ref: ObjectRef) => Effect.Effect<void, RelayStoreFailed>
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
  const nowMillis = yield* Clock.currentTimeMillis
  let clock = nowMillis
  const now = () => clock
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
            }),
            signal === undefined ? undefined : { signal }
          )
        return relayProvider(backend.id, backend.name, runner, now)
      })
  )
  const models = relayModels(providers)

  // Confirmations waiting for a person, with the event that shows them, so a dock that reconnects
  // mid-confirmation sees the card again after its Snapshot.
  const pending = new Map<string, { readonly decision: Deferred.Deferred<boolean>; readonly event: Unsequenced }>()
  const pendingFor = (session: string): ReadonlyArray<Unsequenced> =>
    [...pending.values()].flatMap(({ event }) => (event.session === session ? [event] : []))
  const confirmations = yield* PubSub.unbounded<{ readonly conversationId: string; readonly event: Unsequenced }>()
  const broker: ConfirmationBroker = {
    ask: (request) =>
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
        })
      )
  }

  const registry = createRegistry()
  registry.install(relayExtension(options.capabilities, runEffect, broker))
  const database = yield* openStore(options.storePath)
  const storage = yield* promise("read the Relay store", () => SqliteStorage.open(database))
  const harness = yield* Effect.acquireRelease(
    promise(
      "start the Relay harness",
      () => Harness.open(storage, { models, registry, now: () => clock }, BACKGROUND_CONTEXT)
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

  const touch = Effect.flatMap(Clock.currentTimeMillis, (millis) =>
    Effect.sync(() => {
      clock = millis
    }))

  return RelayHarness.of({
    tools: options.capabilities.map((capability) => ({
      name: capability.name,
      effect: capability.effect,
      available: true
    })),
    send: (ref, text, requestId) =>
      Effect.gen(function*() {
        yield* touch
        const conversation = yield* conversationFor(ref)
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
        if (waiting === undefined) return yield* new RelayDecisionNotPending({ callId })
        pending.delete(callId)
        yield* Deferred.succeed(waiting.decision, allow)
      }),
    cancel: (ref) =>
      Effect.flatMap(
        conversationFor(ref),
        (conversation) => promise("cancel the run", () => conversation.abort(BACKGROUND_CONTEXT))
      )
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
const decodeCites = Schema.decodeUnknownOption(Schema.Struct({ cites: Schema.Array(ObjectRef) }))

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
  const cites = new Map<string, ReadonlyArray<ObjectRef>>()
  // Text already shown per content block of the in-flight message, so each change emits only what's new.
  const sent = new Map<number, string>()
  const textFrom = (index: number, full: string): ReadonlyArray<Unsequenced> => {
    const before = sent.get(index) ?? ""
    sent.set(index, full)
    return full.length > before.length && full.startsWith(before)
      ? [{ _tag: "TextDelta", session, text: full.slice(before.length) }]
      : []
  }
  const toRelay = (event: AgentEvent): ReadonlyArray<Unsequenced> => {
    switch (event.type) {
      case "snapshot":
        return [{
          _tag: "Snapshot",
          session,
          messages: event.entries.flatMap((
            entry
          ): ReadonlyArray<{ readonly role: "user" | "relay"; readonly text: string }> =>
            entry.kind === "pi.user"
              ? [{ role: "user", text: entryText(entry.model) }]
              : entry.kind === "pi.assistant"
              ? [{ role: "relay", text: entryText(entry.model) }]
              : []
          )
        }, ...pendingFor(session)]
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
        return [{ _tag: "ToolFinished", session, call: event.toolCallId, ok: event.entry !== undefined, cites: cited }]
      }
      case "run_end":
        return [{ _tag: "RunFinished", session }]
      case "task_failed":
        return [{
          _tag: "RunFailed",
          session,
          cause: "The run stopped on an error",
          fix: "Retry the message; if it fails again, check the backend in setup."
        }]
      default:
        return []
    }
  }
  const gate = Stream.fromPubSub(confirmations).pipe(
    Stream.filter(({ conversationId }) => conversationId === session),
    Stream.map(({ event }) => event)
  )
  let seq = 0
  return Stream.merge(Stream.flatMap(fromPi, (event) => Stream.fromIterable(toRelay(event))), gate).pipe(
    Stream.map((event): RelayEvent => ({ ...event, seq: seq++ }))
  )
}
