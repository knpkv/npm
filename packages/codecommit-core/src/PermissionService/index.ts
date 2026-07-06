/**
 * @title PermissionService — permission state management
 *
 * Ref<Config> backed by `~/.codecommit/permissions.json`.
 *
 * On construction (Layer build time), reads the file
 * into a Ref. All subsequent `check()` calls are O(1) Ref lookups — no disk
 * I/O. Only `set()` mutates the Ref AND writes to disk (atomic: tmp → rename).
 *
 * Key invariant: an operation missing from the file defaults to `"allow"`,
 * which means "prompt the user". A fresh install with empty permissions.json
 * prompts for every API call — zero-trust by default.
 *
 * @module
 */
import { Config, Context, Effect, Layer, Ref, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"
import { allOperations, getOperationMeta, type OperationName, registerOperation } from "./operations.js"

export type { BuiltinOperation, OperationMeta, OperationName } from "./operations.js"
export { allOperations, getOperationMeta, registerOperation }

// On-disk format. Schema.decodeUnknownSync with defaults means
// corrupt or missing files gracefully degrade to empty state (everything prompts).

export const PermissionState = Schema.Literals(["always_allow", "allow", "deny"])
export type PermissionState = typeof PermissionState.Type
const emptyPermissions: Record<string, PermissionState> = {}
const defaultPermissionState: PermissionState = "allow"

const AuditConfig = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))),
  retentionDays: Schema.Number.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(30)))
})

const PermissionsConfig = Schema.Struct({
  permissions: Schema.Record(Schema.String, PermissionState).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(emptyPermissions))
  ),
  audit: AuditConfig.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(Schema.decodeSync(AuditConfig)({})))
  )
})

type PermissionsConfig = typeof PermissionsConfig.Type

const decodeConfig = Schema.decodeUnknownSync(PermissionsConfig)

// Uses Effect FileSystem — works in Bun, Node, tests.
// Atomic write: write to .tmp, then rename. Prevents corruption on crash.

const resolvePermissionsPath = Config.string("HOME").pipe(
  Config.orElse(() => Config.string("USERPROFILE")),
  Config.map((h) => `${h}/.codecommit/permissions.json`)
)

const loadFromDisk = (fs: FileSystem.FileSystem, path: string): Effect.Effect<PermissionsConfig> =>
  fs.readFileString(path).pipe(
    Effect.map((content) => decodeConfig(JSON.parse(content))),
    // Any failure → empty config → everything prompts
    Effect.catchCause(() => Effect.succeed(decodeConfig({})))
  )

const saveToDisk = (fs: FileSystem.FileSystem, path: string, config: PermissionsConfig): Effect.Effect<void> =>
  Effect.gen(function*() {
    const dir = path.replace(/\/[^/]+$/, "")
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.catchCause(() => Effect.void))
    const tmpPath = `${path}.tmp`
    yield* fs.writeFileString(tmpPath, JSON.stringify(config, null, 2))
    yield* fs.rename(tmpPath, path)
  }).pipe(Effect.catchCause(() => Effect.void))

export interface PermissionServiceShape {
  readonly check: (operation: OperationName) => Effect.Effect<PermissionState>
  readonly set: (operation: OperationName, state: PermissionState) => Effect.Effect<void>
  readonly getAll: () => Effect.Effect<Record<string, PermissionState>>
  readonly resetAll: () => Effect.Effect<void>
  readonly isAuditEnabled: () => Effect.Effect<boolean>
  readonly getAuditRetention: () => Effect.Effect<number>
  readonly setAudit: (
    opts: { enabled?: boolean | undefined; retentionDays?: number | undefined }
  ) => Effect.Effect<void>
}

const makePermissionService = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const permPath = yield* resolvePermissionsPath.pipe(
    Effect.catchCause(() => Effect.succeed("/tmp/.codecommit/permissions.json"))
  )
  // In-memory state. All check() calls read from here.
  // Only set() mutates it AND writes to disk.
  const initial = yield* loadFromDisk(fs, permPath)
  const configRef = yield* Ref.make<PermissionsConfig>(initial)

  // O(1) — Ref.get + property lookup. The "allow" default is the key invariant:
  // missing operation → prompt the user.
  const check = (operation: OperationName): Effect.Effect<PermissionState> =>
    Ref.get(configRef).pipe(Effect.map((c) => c.permissions[operation] ?? defaultPermissionState))

  const set = (operation: OperationName, state: PermissionState): Effect.Effect<void> =>
    Effect.gen(function*() {
      yield* Ref.update(configRef, (c) => ({
        ...c,
        permissions: { ...c.permissions, [operation]: state }
      }))
      yield* saveToDisk(fs, permPath, yield* Ref.get(configRef))
    })

  const getAll = (): Effect.Effect<Record<string, PermissionState>> =>
    Ref.get(configRef).pipe(Effect.map((c) => c.permissions))

  const resetAll = (): Effect.Effect<void> =>
    Effect.gen(function*() {
      yield* Ref.update(configRef, (c) => ({ ...c, permissions: {} }))
      yield* saveToDisk(fs, permPath, yield* Ref.get(configRef))
    })

  const isAuditEnabled = (): Effect.Effect<boolean> => Ref.get(configRef).pipe(Effect.map((c) => c.audit.enabled))

  const getAuditRetention = (): Effect.Effect<number> =>
    Ref.get(configRef).pipe(Effect.map((c) => c.audit.retentionDays))

  const setAudit = (
    opts: { enabled?: boolean | undefined; retentionDays?: number | undefined }
  ): Effect.Effect<void> =>
    Effect.gen(function*() {
      yield* Ref.update(configRef, (c) => ({
        ...c,
        audit: {
          enabled: opts.enabled ?? c.audit.enabled,
          retentionDays: opts.retentionDays ?? c.audit.retentionDays
        }
      }))
      yield* saveToDisk(fs, permPath, yield* Ref.get(configRef))
    })

  return { check, set, getAll, resetAll, isAuditEnabled, getAuditRetention, setAudit } satisfies PermissionServiceShape
})

// Context.Service key with an explicit live layer for v4 beta.
// The effect block runs once at Layer construction: reads file, creates Ref.
// FileSystem comes from the providing layer (PlatformLive in Server.ts).
export class PermissionService extends Context.Service<
  PermissionService,
  PermissionServiceShape
>()("PermissionService") {
  static readonly Default = Layer.effect(PermissionService, makePermissionService)
}
