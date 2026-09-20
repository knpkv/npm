/** Private, versioned bindings between confirmed session writes and provider entries. */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
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

const LedgerFile = Schema.Struct({
  version: Schema.Literal(1),
  reviewedWindows: Schema.Array(ReviewedWindow),
  pending: Schema.Array(Identity),
  bindings: Schema.Array(Binding)
}).check(Schema.makeFilter((value) => {
  const keys = value.bindings.map((binding) => JSON.stringify([binding.provider, binding.scope, binding.entryId]))
  return new Set(keys).size === keys.length &&
    value.pending.every(validDuration) && value.bindings.every(validDuration)
}, { expected: "unique provider entry bindings with valid source duration" }))

export type LedgerFile = typeof LedgerFile.Type

const empty: LedgerFile = { version: 1, reviewedWindows: [], pending: [], bindings: [] }
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(LedgerFile), { onExcessProperty: "error" })

export class SourceLedgerError extends Schema.TaggedError<SourceLedgerError>()("SourceLedgerError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export interface SourceLedgerContract {
  readonly read: Effect.Effect<LedgerFile, SourceLedgerError>
  readonly reserve: (identity: SourceIdentity) => Effect.Effect<void, SourceLedgerError>
  readonly bind: (identity: SourceIdentity, entryId: string) => Effect.Effect<void, SourceLedgerError>
  readonly release: (identity: SourceIdentity) => Effect.Effect<void, SourceLedgerError>
  readonly ensureWindow: (
    window: SourceWindow,
    observedCount: number,
    markerBindings: ReadonlyArray<SourceBinding>
  ) => Effect.Effect<void, SourceLedgerError>
}

export class SourceLedger extends Context.Service<SourceLedger, SourceLedgerContract>()("jcf/SourceLedger") {}

const sameIdentity = (left: SourceIdentity, right: SourceIdentity): boolean =>
  left.provider === right.provider && left.scope === right.scope && left.rowId === right.rowId &&
  left.sourceStartMs === right.sourceStartMs && left.startMs === right.startMs &&
  left.endMs === right.endMs && left.seconds === right.seconds && left.ticketKey === right.ticketKey

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
        yield* fs.writeFileString(lock, "held", { flag: "wx", mode: 0o600 })
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

    const reserve = (identity: SourceIdentity) =>
      update((current) =>
        Effect.gen(function*() {
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

    const ensureWindow = (window: SourceWindow, observedCount: number, markerBindings: ReadonlyArray<SourceBinding>) =>
      update((current) =>
        Effect.gen(function*() {
          if (window.toMs <= window.fromMs || observedCount < 0 || !Number.isInteger(observedCount)) {
            return yield* new SourceLedgerError({ message: "Invalid provider review window" })
          }
          if (
            current.reviewedWindows.some((known) =>
              known.provider === window.provider &&
              known.scope === window.scope && known.fromMs <= window.fromMs && known.toMs >= window.toMs
            )
          ) {
            return current
          }
          const unique = new Set(markerBindings.map((binding) => binding.entryId))
          if (
            unique.size !== observedCount ||
            markerBindings.some((binding) => binding.provider !== window.provider || binding.scope !== window.scope)
          ) {
            return yield* new SourceLedgerError({
              message: "Unlinked earlier provider entries need private manual review before session writes"
            })
          }
          return {
            ...current,
            reviewedWindows: [...current.reviewedWindows, window],
            bindings: [
              ...current.bindings,
              ...markerBindings.filter((binding) =>
                !current.bindings.some((known) =>
                  known.provider === binding.provider &&
                  known.scope === binding.scope && known.entryId === binding.entryId
                )
              )
            ]
          }
        })
      )

    return SourceLedger.of({ read, reserve, bind, release, ensureWindow })
  })
)
