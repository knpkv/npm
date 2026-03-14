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
import { FileSystem } from "@effect/platform"
import { Config, Effect, Ref, Schema } from "effect"
import { allOperations, getOperationMeta, type OperationName, registerOperation } from "./operations.js"

export type { BuiltinOperation, OperationMeta, OperationName } from "./operations.js"
export { allOperations, getOperationMeta, registerOperation }

// On-disk format. Schema.decodeUnknownSync with defaults means
// corrupt or missing files gracefully degrade to empty state (everything prompts).

export const PermissionState = Schema.Literal("always_allow", "allow", "deny")
export type PermissionState = typeof PermissionState.Type

const AuditConfig = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.optionalWith({ default: () => true })),
  retentionDays: Schema.Number.pipe(Schema.optionalWith({ default: () => 30 }))
})

const PermissionsConfig = Schema.Struct({
  permissions: Schema.Record({ key: Schema.String, value: PermissionState }).pipe(
    Schema.optionalWith({ default: () => ({}) as Record<string, PermissionState> })
  ),
  audit: AuditConfig.pipe(
    Schema.optionalWith({ default: () => Schema.decodeSync(AuditConfig)({}) })
  )
})

type PermissionsConfig = typeof PermissionsConfig.Type

const decodeConfig = Schema.decodeUnknownSync(PermissionsConfig)

// Uses @effect/platform FileSystem — works in Bun, Node, tests.
// Atomic write: write to .tmp, then rename. Prevents corruption on crash.

const resolvePermissionsPath = Config.string("HOME").pipe(
  Config.orElse(() => Config.string("USERPROFILE")),
  Config.map((h) => `${h}/.codecommit/permissions.json`)
)

const loadFromDisk = (fs: FileSystem.FileSystem, path: string): Effect.Effect<PermissionsConfig> =>
  fs.readFileString(path).pipe(
    Effect.map((content) => decodeConfig(JSON.parse(content))),
    // Any failure → empty config → everything prompts
    Effect.catchAll(() => Effect.succeed(decodeConfig({})))
  )

const saveToDisk = (fs: FileSystem.FileSystem, path: string, config: PermissionsConfig): Effect.Effect<void> =>
  Effect.gen(function*() {
    const dir = path.replace(/\/[^/]+$/, "")
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.catchAll(() => Effect.void))
    const tmpPath = `${path}.tmp`
    yield* fs.writeFileString(tmpPath, JSON.stringify(config, null, 2))
    yield* fs.rename(tmpPath, path)
  }).pipe(Effect.catchAll(() => Effect.void))

// Effect.Service (not Context.Tag) — auto-generates `.Default` layer.
// The effect block runs once at Layer construction: reads file, creates Ref.
// FileSystem comes from the providing layer (PlatformLive in Server.ts).

export class PermissionService extends Effect.Service<PermissionService>()("PermissionService", {
  effect: Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const permPath = yield* Effect.configProviderWith((p) => p.load(resolvePermissionsPath)).pipe(
      Effect.catchAll(() => Effect.succeed("/tmp/.codecommit/permissions.json"))
    )
    // In-memory state. All check() calls read from here.
    // Only set() mutates it AND writes to disk.
    const initial = yield* loadFromDisk(fs, permPath)
    const configRef = yield* Ref.make<PermissionsConfig>(initial)

    // O(1) — Ref.get + property lookup. The "allow" default is the key invariant:
    // missing operation → prompt the user.
    const check = (operation: OperationName): Effect.Effect<PermissionState> =>
      Ref.get(configRef).pipe(Effect.map((c) => c.permissions[operation] ?? ("allow" as const)))

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

    return { check, set, getAll, resetAll, isAuditEnabled, getAuditRetention, setAudit }
  })
}) {}
