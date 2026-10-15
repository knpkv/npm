import type { FleetService, HostOperations } from "@knpkv/herdr-fleet"
import type { WorkProjectionError, WorkStoreError } from "@knpkv/herdr-work"
import { Effect, Ref } from "effect"
import type { TaskWorkObservation } from "./agent-task-work.js"

type TaskWorkRead = Effect.Effect<ReadonlyArray<TaskWorkObservation>, WorkStoreError | WorkProjectionError>
type TaskWorkOwner = HostOperations["listAgents"] | FleetService
type TaskWorkRegistration = { readonly close: Effect.Effect<void> }
type RegisterWork = (read: TaskWorkRead) => Effect.Effect<TaskWorkRegistration>
const registrations = new WeakMap<TaskWorkOwner, RegisterWork>()

/** Retains only the HTTP-owned reader; a retired lifetime cannot detach its replacement. */
export const makeTaskWorkSource = Effect.fn("TaskEvidence.makeWorkSource")(function*() {
  const current = yield* Ref.make<{ readonly read: TaskWorkRead } | null>(null)
  /** The HTTP lifetime owns its reader; late cleanup cannot detach a replacement. */
  const register = Effect.fn("TaskEvidence.registerWorkReader")(function*(read: TaskWorkRead) {
    const registration = { read }
    yield* Ref.set(current, registration)
    return {
      close: Ref.update(current, (active) => active === registration ? null : active)
    } satisfies TaskWorkRegistration
  })
  const observations = Effect.fn("TaskEvidence.workObservations")(function*() {
    const registration = yield* Ref.get(current)
    if (registration === null) return []
    return yield* registration.read.pipe(
      Effect.tapError((error) => Effect.logWarning("AgentTaskWorkUnavailable", { causeTag: error._tag })),
      Effect.catch(() => Effect.succeed<ReadonlyArray<TaskWorkObservation>>([]))
    )
  })
  return { observations: observations(), register }
})

/** Package-private registration bridge. Nothing is added to public options, barrels or wire models. */
export const registerTaskWorkSource = (owner: HostOperations["listAgents"], register: RegisterWork) =>
  Effect.sync(() => {
    registrations.set(owner, register)
  })

/** Preserves the private source through operations composition, then binds it to the exact Fleet service. */
export const copyTaskWorkRegistration = (source: HostOperations["listAgents"], owner: TaskWorkOwner) =>
  Effect.sync(() => {
    const registration = registrations.get(source)
    if (registration !== undefined) registrations.set(owner, registration)
  })

/** The HTTP scope registers existing Work facts and immediately owns the returned close handle. */
export const attachTaskWorkReader = Effect.fn("TaskEvidence.attachWorkReader")(
  function*(owner: TaskWorkOwner, read: TaskWorkRead) {
    const register = registrations.get(owner)
    return register === undefined ? { close: Effect.void } : yield* register(read)
  }
)
