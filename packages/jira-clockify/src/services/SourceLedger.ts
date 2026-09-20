/** Private, versioned bindings between confirmed session writes and provider entries. */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { ConfigService } from "./ConfigService.js"

const validDuration = (value: { readonly startMs: number; readonly endMs: number; readonly seconds: number }) =>
  value.endMs > value.startMs && Math.abs((value.endMs - value.startMs) / 1000 - value.seconds) < 0.000_001

const Identity = Schema.Struct({
  provider: Schema.Literals(["clockify", "jira"]),
  scope: Schema.NonEmptyString,
  rowId: Schema.NonEmptyString,
  sourceStartMs: Schema.Finite,
  startMs: Schema.Finite,
  endMs: Schema.Finite,
  seconds: Schema.Finite.check(Schema.isGreaterThan(0)),
  ticketKey: Schema.NonEmptyString
}).check(
  Schema.makeFilter(
    validDuration,
    {
      expected: "source segment duration matches its interval"
    }
  )
)

export interface SourceIdentity extends Schema.Schema.Type<typeof Identity> {}

const Binding = Identity.pipe(Schema.fieldsAssign({ entryId: Schema.NonEmptyString }))
export interface SourceBinding extends Schema.Schema.Type<typeof Binding> {}

const ReviewedWindow = Schema.Struct({
  provider: Schema.Literals(["clockify", "jira"]),
  scope: Schema.NonEmptyString,
  fromMs: Schema.Finite,
  toMs: Schema.Finite
}).check(Schema.makeFilter((value) => value.toMs > value.fromMs, { expected: "non-empty review window" }))
export interface SourceWindow extends Schema.Schema.Type<typeof ReviewedWindow> {}

const ObservedUnbound = Schema.Struct({
  provider: Schema.Literals(["clockify", "jira"]),
  scope: Schema.NonEmptyString,
  entryId: Schema.NonEmptyString,
  startMs: Schema.Finite
})

const LegacyLedgerFile = Schema.Struct({
  version: Schema.Literal(1),
  reviewedWindows: Schema.Array(ReviewedWindow),
  pending: Schema.Array(Identity),
  bindings: Schema.Array(Binding)
})

const V2LedgerFile = Schema.Struct({
  version: Schema.Literal(2),
  reviewedWindows: Schema.Array(ReviewedWindow),
  pending: Schema.Array(Identity),
  bindings: Schema.Array(Binding),
  observedUnbound: Schema.Array(ObservedUnbound)
})

const LedgerFile = Schema.Struct({
  version: Schema.Literal(3),
  reviewedWindows: Schema.Array(ReviewedWindow),
  pending: Schema.Array(Identity),
  bindings: Schema.Array(Binding),
  observedUnbound: Schema.Array(ObservedUnbound)
}).check(Schema.makeFilter((value) => {
  const keys = value.bindings.map((binding) => JSON.stringify([binding.provider, binding.scope, binding.entryId]))
  const observedKeys = value.observedUnbound.map((entry) =>
    JSON.stringify([entry.provider, entry.scope, entry.entryId])
  )
  return new Set(keys).size === keys.length &&
    new Set(observedKeys).size === observedKeys.length &&
    observedKeys.every((key) => !keys.includes(key)) &&
    value.observedUnbound.every((entry) =>
      entry.entryId.trim() !== "" &&
      value.reviewedWindows.some((window) =>
        window.provider === entry.provider && window.scope === entry.scope &&
        window.fromMs <= entry.startMs && entry.startMs < window.toMs
      )
    ) &&
    value.pending.every(validDuration) && value.bindings.every(validDuration)
}, { expected: "valid reviewed observations, unique provider entries and source durations" }))

export type LedgerFile = typeof LedgerFile.Type

const empty: LedgerFile = { version: 3, reviewedWindows: [], pending: [], bindings: [], observedUnbound: [] }
const decodeStored = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([LegacyLedgerFile, V2LedgerFile, LedgerFile])),
  { onExcessProperty: "error" }
)
const decode = (content: string) =>
  decodeStored(content).pipe(
    Effect.flatMap((stored) =>
      stored.version === 3
        ? Effect.succeed(stored)
        : Schema.decodeEffect(LedgerFile)({
          ...stored,
          version: 3,
          observedUnbound: stored.version === 1 ? [] : stored.observedUnbound
        })
    )
  )
const positiveProcessNumber = Schema.Number.check(Schema.makeFilter(
  (value) => Number.isSafeInteger(value) && value > 0,
  { expected: "positive process identity" }
))
const LockOwner = Schema.Struct({
  version: Schema.Literal(1),
  pid: positiveProcessNumber,
  namespace: positiveProcessNumber
})
const decodeLockOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(LockOwner), { onExcessProperty: "error" })
const lockOwner = (pid: number, namespace: number): typeof LockOwner.Type => ({ version: 1, pid, namespace })

export class SourceLedgerError extends Schema.TaggedError<SourceLedgerError>()("SourceLedgerError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export interface SourceLedgerContract {
  readonly read: Effect.Effect<LedgerFile, SourceLedgerError>
  readonly assertNoLegacyClockify: (legacyScope: string) => Effect.Effect<void, SourceLedgerError>
  readonly reserve: (identity: SourceIdentity, legacyScope?: string) => Effect.Effect<void, SourceLedgerError>
  readonly bind: (identity: SourceIdentity, entryId: string) => Effect.Effect<void, SourceLedgerError>
  readonly release: (identity: SourceIdentity) => Effect.Effect<void, SourceLedgerError>
  readonly ensureWindow: (
    window: SourceWindow,
    observed: ReadonlyArray<{ readonly entryId: string; readonly startMs: number }>,
    markerBindings: ReadonlyArray<SourceBinding>,
    legacyScope?: string
  ) => Effect.Effect<void, SourceLedgerError>
}

export class SourceLedger extends Context.Service<SourceLedger, SourceLedgerContract>()("jcf/SourceLedger") {}

const sameIdentity = (left: SourceIdentity, right: SourceIdentity): boolean =>
  left.provider === right.provider && left.scope === right.scope && left.rowId === right.rowId &&
  left.sourceStartMs === right.sourceStartMs && left.startMs === right.startMs &&
  left.endMs === right.endMs && left.seconds === right.seconds && left.ticketKey === right.ticketKey

const hasLegacyClockify = (current: LedgerFile, legacyScope: string): boolean =>
  current.reviewedWindows.some((value) => value.provider === "clockify" && value.scope === legacyScope) ||
  current.observedUnbound.some((value) => value.provider === "clockify" && value.scope === legacyScope) ||
  current.pending.some((value) => value.provider === "clockify" && value.scope === legacyScope) ||
  current.bindings.some((value) => value.provider === "clockify" && value.scope === legacyScope)

const rejectLegacyClockify = (current: LedgerFile, legacyScope: string) =>
  hasLegacyClockify(current, legacyScope)
    ? Effect.fail(new SourceLedgerError({ message: "Earlier Clockify scope needs private manual consumption review" }))
    : Effect.void

/** A pending remote create never becomes permission to repeat it after a crash. */
export const layer = Layer.effect(
  SourceLedger,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = yield* ConfigService
    const dir = yield* config.configDir
    const file = path.join(dir, "source-consumption.v1.json")
    const temporary = `${file}.tmp`
    const lock = `${file}.lock`
    const recovery = `${lock}.recovery`

    const ownLockIdentity = Effect.gen(function*() {
      const stat = yield* fs.readFileString("/proc/self/stat")
      const pid = Number(/^\d+/u.exec(stat)?.[0])
      const namespace = Option.getOrUndefined((yield* fs.stat("/proc/self/ns/pid")).ino)
      if (
        !Number.isSafeInteger(pid) || pid <= 0 || namespace === undefined ||
        !Number.isSafeInteger(namespace) || namespace <= 0
      ) return null
      return lockOwner(pid, namespace)
    }).pipe(Effect.catch(() => Effect.succeed(null)))

    const acquireLock = Effect.gen(function*() {
      // On hosts without a verifiable process namespace, exclusive creation still works; a
      // leftover lock requires manual recovery rather than a guessed liveness decision.
      const owner = yield* ownLockIdentity
      const content = owner === null ? "held" : JSON.stringify(owner)
      yield* fs.writeFileString(lock, content, { flag: "wx", mode: 0o600 }).pipe(
        Effect.catch((cause) =>
          Effect.gen(function*() {
            if (!(yield* fs.exists(lock))) return yield* cause
            yield* fs.writeFileString(recovery, "recovering", { flag: "wx", mode: 0o600 })
            return yield* Effect.gen(function*() {
              const info = yield* fs.stat(lock)
              const realDirectory = yield* fs.realPath(dir)
              if (
                info.type !== "File" || (info.mode & 0o077) !== 0 ||
                (yield* fs.realPath(lock)) !== path.join(realDirectory, "source-consumption.v1.json.lock")
              ) {
                return yield* new SourceLedgerError({
                  message: "Private consumption lock has unsafe type or permissions"
                })
              }
              const previous = yield* decodeLockOwner(yield* fs.readFileString(lock)).pipe(
                Effect.mapError((decodeCause) =>
                  new SourceLedgerError({
                    message: "Private consumption lock needs manual recovery",
                    cause: decodeCause
                  })
                )
              )
              if (owner === null || owner.namespace !== previous.namespace || owner.pid === previous.pid) {
                return yield* new SourceLedgerError({ message: "Private consumption lock may have a live holder" })
              }
              const holderGone = yield* fs.stat(`/proc/${previous.pid}/stat`).pipe(
                Effect.map(() => false),
                Effect.catch((probeCause) =>
                  probeCause.reason._tag === "NotFound"
                    ? Effect.succeed(true)
                    : Effect.fail(probeCause)
                )
              )
              if (!holderGone) {
                return yield* new SourceLedgerError({ message: "Private consumption lock may have a live holder" })
              }
              yield* fs.remove(lock)
              yield* fs.writeFileString(lock, content, { flag: "wx", mode: 0o600 })
            }).pipe(Effect.onExit(() => fs.remove(recovery)))
          })
        )
      )
    })

    const syncPath = (target: string) =>
      Effect.scoped(Effect.gen(function*() {
        const handle = yield* fs.open(target, { flag: "r" })
        yield* handle.sync
      }))

    const read = Effect.gen(function*() {
      const exists = yield* fs.exists(file)
      if (!exists) return empty
      const info = yield* fs.stat(file)
      const directory = yield* fs.stat(dir)
      const realDirectory = yield* fs.realPath(dir)
      const realFile = yield* fs.realPath(file)
      if (
        info.type !== "File" || (info.mode & 0o077) !== 0 ||
        directory.type !== "Directory" || (directory.mode & 0o022) !== 0 ||
        realFile !== path.join(realDirectory, "source-consumption.v1.json")
      ) {
        return yield* new SourceLedgerError({ message: "Private consumption ledger has unsafe permissions or type" })
      }
      return yield* decode(yield* fs.readFileString(file)).pipe(
        Effect.mapError((cause) => new SourceLedgerError({ message: "Private consumption ledger is invalid", cause }))
      )
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "SourceLedgerError"
          ? cause
          : new SourceLedgerError({ message: "Could not read private consumption ledger", cause })
      )
    )

    const update = (change: (current: LedgerFile) => Effect.Effect<LedgerFile, SourceLedgerError>) =>
      Effect.gen(function*() {
        yield* fs.makeDirectory(dir, { recursive: true })
        const directory = yield* fs.stat(dir)
        if (directory.type !== "Directory" || (directory.mode & 0o022) !== 0) {
          return yield* new SourceLedgerError({ message: "Private consumption directory is writable by others" })
        }
        yield* acquireLock
        return yield* Effect.gen(function*() {
          const next = yield* change(yield* read)
          yield* Schema.decodeEffect(LedgerFile)(next).pipe(
            Effect.mapError((cause) => new SourceLedgerError({ message: "Invalid consumption ledger update", cause }))
          )
          // Exclusive creation makes a leftover temp file a visible recovery case, not an overwrite.
          yield* fs.writeFileString(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 })
          yield* syncPath(temporary)
          yield* fs.rename(temporary, file)
          yield* syncPath(dir)
        }).pipe(Effect.onExit(() => fs.remove(lock)))
      }).pipe(
        Effect.mapError((cause) =>
          cause._tag === "SourceLedgerError"
            ? cause
            : new SourceLedgerError({ message: "Could not update private consumption ledger", cause })
        )
      )

    const assertNoLegacyClockify = (legacyScope: string) =>
      read.pipe(Effect.flatMap((current) => rejectLegacyClockify(current, legacyScope)))

    const reserve = (identity: SourceIdentity, legacyScope?: string) =>
      update((current) =>
        Effect.gen(function*() {
          if (identity.provider === "clockify" && legacyScope !== undefined) {
            yield* rejectLegacyClockify(current, legacyScope)
          }
          yield* Schema.decodeEffect(Identity)(identity).pipe(
            Effect.mapError((cause) => new SourceLedgerError({ message: "Invalid source identity", cause }))
          )
          if (identity.endMs <= identity.startMs || identity.seconds <= 0) {
            return yield* new SourceLedgerError({ message: "Invalid source duration" })
          }
          if (
            !current.reviewedWindows.some((window) =>
              window.provider === identity.provider &&
              window.scope === identity.scope && window.fromMs <= identity.startMs && window.toMs >= identity.endMs
            )
          ) {
            return yield* new SourceLedgerError({ message: "Earlier provider entries need manual consumption review" })
          }
          if (
            current.pending.some((pending) =>
              pending.provider === identity.provider &&
              pending.scope === identity.scope && pending.rowId === identity.rowId
            )
          ) {
            return yield* new SourceLedgerError({
              message: "Source has an unresolved remote write; reconcile it manually"
            })
          }
          return { ...current, pending: [...current.pending, identity] }
        })
      )

    const bind = (identity: SourceIdentity, entryId: string) =>
      update((current) =>
        Effect.gen(function*() {
          const pending = current.pending.find((value) => sameIdentity(value, identity))
          if (pending === undefined || entryId.trim() === "") {
            return yield* new SourceLedgerError({
              message: "Successful write has no unique pending identity or provider ID"
            })
          }
          if (
            current.bindings.some((value) =>
              value.provider === identity.provider &&
              value.scope === identity.scope && value.entryId === entryId
            )
          ) {
            return yield* new SourceLedgerError({ message: "Provider entry is already bound" })
          }
          return {
            ...current,
            pending: current.pending.filter((value) => !sameIdentity(value, identity)),
            bindings: [...current.bindings, { ...pending, entryId }]
          }
        })
      )

    const release = (identity: SourceIdentity) =>
      update((current) =>
        Effect.succeed({
          ...current,
          pending: current.pending.filter((value) => !sameIdentity(value, identity))
        })
      )

    const ensureWindow = (
      window: SourceWindow,
      observed: ReadonlyArray<{ readonly entryId: string; readonly startMs: number }>,
      markerBindings: ReadonlyArray<SourceBinding>,
      legacyScope?: string
    ) =>
      update((current) =>
        Effect.gen(function*() {
          if (window.provider === "clockify" && legacyScope !== undefined) {
            yield* rejectLegacyClockify(current, legacyScope)
          }
          if (
            window.toMs <= window.fromMs ||
            observed.some((entry) => entry.entryId.trim() === "" || !Number.isFinite(entry.startMs))
          ) {
            return yield* new SourceLedgerError({ message: "Invalid provider review window" })
          }
          const priorWindows = current.reviewedWindows.filter((known) =>
            known.provider === window.provider && known.scope === window.scope
          )
          const latestReviewedEnd = priorWindows.reduce((latest, known) => Math.max(latest, known.toMs), -Infinity)
          const knownBindings = [...current.bindings, ...markerBindings].filter((binding) =>
            binding.provider === window.provider && binding.scope === window.scope
          )
          const knownBoundIds = new Set(knownBindings.map((binding) => binding.entryId))
          const previousOrdinary = current.observedUnbound.filter((entry) =>
            entry.provider === window.provider && entry.scope === window.scope
          )
          const ordinaryById = new Map(previousOrdinary.map((entry) => [entry.entryId, entry.startMs]))
          if (
            new Set(observed.map((entry) => entry.entryId)).size !== observed.length ||
            markerBindings.some((binding) =>
              binding.provider !== window.provider || binding.scope !== window.scope ||
              binding.entryId.trim() === "" ||
              ordinaryById.has(binding.entryId)
            ) ||
            observed.some((entry) =>
              ordinaryById.has(entry.entryId) && ordinaryById.get(entry.entryId) !== entry.startMs
            )
          ) {
            return yield* new SourceLedgerError({
              message: "Unlinked earlier provider entries need private manual review before session writes"
            })
          }
          const newlyOrdinary = observed.filter((entry) =>
            !knownBoundIds.has(entry.entryId) && !ordinaryById.has(entry.entryId)
          )
          if (
            newlyOrdinary.some((entry) =>
              priorWindows.length === 0 || window.fromMs > latestReviewedEnd ||
              entry.startMs < latestReviewedEnd ||
              entry.startMs < window.fromMs || entry.startMs >= window.toMs
            )
          ) {
            return yield* new SourceLedgerError({
              message: "Unlinked earlier provider entries need private manual review before session writes"
            })
          }
          const covered = priorWindows.some((known) => known.fromMs <= window.fromMs && known.toMs >= window.toMs)
          return {
            ...current,
            reviewedWindows: covered ? current.reviewedWindows : [...current.reviewedWindows, window],
            bindings: [
              ...current.bindings,
              ...markerBindings.filter((binding) =>
                !current.bindings.some((known) =>
                  known.provider === binding.provider &&
                  known.scope === binding.scope && known.entryId === binding.entryId
                )
              )
            ],
            observedUnbound: [
              ...current.observedUnbound,
              ...newlyOrdinary.map((entry) => ({ provider: window.provider, scope: window.scope, ...entry }))
            ]
          }
        })
      )

    return SourceLedger.of({ read, assertNoLegacyClockify, reserve, bind, release, ensureWindow })
  })
)
