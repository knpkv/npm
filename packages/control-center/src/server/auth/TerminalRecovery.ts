import type { FileSystem as FileSystemType, Path as PathType } from "effect"
import {
  Clock,
  Context,
  Crypto,
  DateTime,
  Effect,
  Encoding,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Result,
  Schema,
  Stdio,
  Stream
} from "effect"

import { Actor } from "../../domain/actors.js"
import { WorkspaceId } from "../../domain/identifiers.js"
import { databaseLayer } from "../persistence/Database.js"
import { decodePersistenceConfig } from "../persistence/PersistenceConfig.js"
import { QuarantineRepository } from "../persistence/repositories/quarantineRepository.js"
import { AuthRepository } from "./AuthRepository.js"
import { AuthCryptoError, TerminalRecoveryRefusedError } from "./errors.js"
import { PAIRING_CODE_LIFETIME_MINUTES, PairingCodeId } from "./models.js"

/** Exact phrase required on standard input before terminal recovery may issue a credential. */
export const TERMINAL_RECOVERY_CONFIRMATION = "ISSUE OWNER RECOVERY CODE"

const RecoveryRequest = Schema.Struct({
  workspaceId: WorkspaceId,
  actor: Actor,
  revokeExistingOwnerSessions: Schema.Boolean
})

const sameIdentity = (left: FileSystemType.File.Info, right: FileSystemType.File.Info): boolean =>
  left.dev === right.dev &&
  Option.isSome(left.ino) &&
  Option.isSome(right.ino) &&
  left.ino.value === right.ino.value &&
  Option.isSome(left.uid) &&
  Option.isSome(right.uid) &&
  left.uid.value === right.uid.value

const descriptorAliases = (
  path: PathType.Path,
  descriptor: FileSystemType.File.Descriptor
): ReadonlyArray<string> => [
  path.join("/proc/self/fd", String(descriptor)),
  path.join("/dev/fd", String(descriptor))
]

const makeTerminalRecovery = (
  recoveryDirectory: string,
  initialDirectoryInfo: FileSystemType.File.Info
) =>
  Effect.gen(function*() {
    const repository = yield* AuthRepository
    const cryptoService = yield* Crypto.Crypto
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const verifyDirectoryInfo = (info: FileSystemType.File.Info) =>
      info.type === "Directory" &&
      (info.mode & 0o777) === 0o700 &&
      sameIdentity(initialDirectoryInfo, info)

    const resolveDirectoryAlias = Effect.fn("TerminalRecovery.resolveDirectoryAlias")(function*(
      descriptor: FileSystemType.File.Descriptor
    ) {
      for (const alias of descriptorAliases(path, descriptor)) {
        const resolved = yield* fileSystem.realPath(alias).pipe(Effect.result)
        if (Result.isSuccess(resolved) && resolved.success === recoveryDirectory) return alias
      }
      return yield* new TerminalRecoveryRefusedError({ reason: "data-directory-owner-mismatch" })
    })

    const verifyProcessOwnership = Effect.fn("TerminalRecovery.verifyProcessOwnership")(function*() {
      yield* Effect.scoped(
        Effect.uninterruptible(
          Effect.gen(function*() {
            const directory = yield* fileSystem.open(recoveryDirectory, { flag: "r" }).pipe(
              Effect.mapError(() => new TerminalRecoveryRefusedError({ reason: "data-directory-unavailable" }))
            )
            const directoryInfo = yield* directory.stat.pipe(
              Effect.mapError(() => new TerminalRecoveryRefusedError({ reason: "data-directory-unavailable" }))
            )
            if (!verifyDirectoryInfo(directoryInfo)) {
              return yield* new TerminalRecoveryRefusedError({ reason: "data-directory-not-private" })
            }
            const alias = yield* resolveDirectoryAlias(directory.fd)
            const assertIdentity = Effect.gen(function*() {
              const current = yield* directory.stat.pipe(Effect.result)
              const resolved = yield* fileSystem.realPath(alias).pipe(Effect.result)
              if (
                Result.isFailure(current) ||
                Result.isFailure(resolved) ||
                resolved.success !== recoveryDirectory ||
                !verifyDirectoryInfo(current.success)
              ) {
                return yield* new TerminalRecoveryRefusedError({ reason: "data-directory-owner-mismatch" })
              }
            })

            yield* assertIdentity
            const random = yield* cryptoService.randomBytes(16).pipe(
              Effect.mapError(() => new AuthCryptoError())
            )
            const probe = path.join(alias, `.recovery-owner-${Encoding.encodeHex(random)}`)
            const opened = yield* fileSystem.open(probe, { flag: "wx", mode: 0o600 }).pipe(
              Effect.mapError(() => new TerminalRecoveryRefusedError({ reason: "data-directory-unavailable" }))
            )
            yield* Effect.addFinalizer(() =>
              fileSystem.remove(probe, { force: true }).pipe(
                Effect.andThen(directory.sync),
                Effect.ignore
              )
            )
            yield* fileSystem.chmod(probe, 0o600).pipe(
              Effect.mapError(() => new TerminalRecoveryRefusedError({ reason: "data-directory-unavailable" }))
            )
            const probeInfo = yield* opened.stat.pipe(
              Effect.mapError(() => new TerminalRecoveryRefusedError({ reason: "data-directory-unavailable" }))
            )
            if (
              probeInfo.type !== "File" ||
              (probeInfo.mode & 0o777) !== 0o600 ||
              Option.isNone(probeInfo.uid) ||
              Option.isNone(directoryInfo.uid) ||
              probeInfo.uid.value !== directoryInfo.uid.value
            ) {
              return yield* new TerminalRecoveryRefusedError({ reason: "data-directory-owner-mismatch" })
            }
            yield* assertIdentity
            yield* fileSystem.remove(probe).pipe(
              Effect.mapError(() => new TerminalRecoveryRefusedError({ reason: "data-directory-unavailable" }))
            )
            yield* directory.sync.pipe(
              Effect.mapError(() => new TerminalRecoveryRefusedError({ reason: "data-directory-unavailable" }))
            )
            yield* assertIdentity
          })
        )
      )
    })

    return {
      issueOwnerRecovery: Effect.fn("TerminalRecovery.issueOwnerRecovery")(function*(
        unknownRequest: unknown
      ) {
        const request = yield* Schema.decodeUnknownEffect(RecoveryRequest)(unknownRequest).pipe(
          Effect.mapError(() => new TerminalRecoveryRefusedError({ reason: "invalid-input" }))
        )
        yield* verifyProcessOwnership()

        const stdio = yield* Stdio.Stdio
        yield* Stream.make(
          `Type ${TERMINAL_RECOVERY_CONFIRMATION} to continue: `
        ).pipe(
          Stream.run(stdio.stderr()),
          Effect.mapError(() => new TerminalRecoveryRefusedError({ reason: "terminal-io-failed" }))
        )
        const confirmation = yield* stdio.stdin.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
          Effect.mapError(() => new TerminalRecoveryRefusedError({ reason: "terminal-io-failed" }))
        )
        if (Option.getOrNull(confirmation) !== TERMINAL_RECOVERY_CONFIRMATION) {
          return yield* new TerminalRecoveryRefusedError({ reason: "confirmation-rejected" })
        }

        const createdAt = DateTime.makeUnsafe(yield* Clock.currentTimeMillis)
        const pairingCodeIdValue = yield* cryptoService.randomUUIDv7.pipe(
          Effect.mapError(() => new AuthCryptoError()),
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(PairingCodeId)(value).pipe(
              Effect.mapError(() => new AuthCryptoError())
            )
          )
        )
        const bytes = yield* cryptoService.randomBytes(32).pipe(
          Effect.mapError(() => new AuthCryptoError())
        )
        const pairingCode = Redacted.make(Encoding.encodeHex(bytes))
        const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
          Effect.mapError(() => new AuthCryptoError())
        )
        const summary = yield* repository.recoverOwner({
          workspaceId: request.workspaceId,
          pairingCodeId: pairingCodeIdValue,
          codeHash: Encoding.encodeHex(digest),
          purpose: "recovery",
          actor: request.actor,
          permission: "workspace-owner",
          issuedBySessionId: null,
          createdAt,
          expiresAt: DateTime.add(createdAt, { minutes: PAIRING_CODE_LIFETIME_MINUTES })
        }, request.revokeExistingOwnerSessions)
        return { pairingCode, summary }
      })
    }
  })

/** Terminal-only recovery workflow; deliberately separate from the HTTP-facing Auth service. */
export class TerminalRecovery extends Context.Service<
  TerminalRecovery,
  Effect.Success<ReturnType<typeof makeTerminalRecovery>>
>()("@knpkv/control-center/server/auth/TerminalRecovery") {}

/** Build terminal recovery from the exact canonical parent of the configured local database. */
export const terminalRecoveryLayer = (persistenceConfigInput: unknown) => {
  const database = databaseLayer(persistenceConfigInput)
  const quarantine = QuarantineRepository.layer.pipe(Layer.provide(database))
  const repository = AuthRepository.layer.pipe(
    Layer.provide(Layer.merge(database, quarantine))
  )
  return Layer.unwrap(
    Effect.gen(function*() {
      const config = yield* decodePersistenceConfig(persistenceConfigInput)
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const databaseUrl = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(config.databaseUrl).pipe(
        Effect.mapError(() => new TerminalRecoveryRefusedError({ reason: "invalid-input" }))
      )
      const databasePath = yield* path.fromFileUrl(databaseUrl).pipe(
        Effect.mapError(() => new TerminalRecoveryRefusedError({ reason: "invalid-input" }))
      )
      const configuredDirectory = path.dirname(databasePath)
      const canonicalDirectory = yield* fileSystem.realPath(configuredDirectory).pipe(
        Effect.mapError(() => new TerminalRecoveryRefusedError({ reason: "data-directory-unavailable" }))
      )
      if (canonicalDirectory !== configuredDirectory) {
        return yield* new TerminalRecoveryRefusedError({ reason: "data-directory-not-private" })
      }
      const info = yield* fileSystem.stat(canonicalDirectory).pipe(
        Effect.mapError(() => new TerminalRecoveryRefusedError({ reason: "data-directory-unavailable" }))
      )
      if (
        info.type !== "Directory" ||
        (info.mode & 0o777) !== 0o700 ||
        Option.isNone(info.uid) ||
        Option.isNone(info.ino)
      ) {
        return yield* new TerminalRecoveryRefusedError({ reason: "data-directory-not-private" })
      }
      return Layer.effect(TerminalRecovery, makeTerminalRecovery(canonicalDirectory, info)).pipe(
        Layer.provide(repository)
      )
    })
  )
}
