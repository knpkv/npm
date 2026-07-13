import { Clock, Context, Crypto, DateTime, Effect, Encoding, Layer, Redacted, Schema } from "effect"

import type { Actor, Role } from "../../domain/actors.js"
import type { WorkspaceId } from "../../domain/identifiers.js"
import { databaseLayer } from "../persistence/Database.js"
import { QuarantineRepository } from "../persistence/repositories/quarantineRepository.js"
import { AuthRepository } from "./AuthRepository.js"
import { AuthCryptoError, AuthPermissionDeniedError, CredentialRejectedError } from "./errors.js"
import {
  PAIRING_CODE_LIFETIME_MINUTES,
  PairingCodeId,
  type PairingCodeId as PairingCodeIdType,
  SESSION_ABSOLUTE_LIFETIME_DAYS,
  SESSION_IDLE_LIFETIME_HOURS,
  SessionId,
  type SessionId as SessionIdType
} from "./models.js"

const TOKEN_BYTES = 32

const fixedTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.byteLength ^ right.byteLength
  const length = Math.max(left.byteLength, right.byteLength)
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

const makeAuth = Effect.gen(function*() {
  const repository = yield* AuthRepository
  const cryptoService = yield* Crypto.Crypto

  const now = Effect.map(Clock.currentTimeMillis, DateTime.makeUnsafe)

  const randomSecret = Effect.fn("Auth.randomSecret")(function*() {
    const bytes = yield* cryptoService.randomBytes(TOKEN_BYTES).pipe(
      Effect.mapError(() => new AuthCryptoError())
    )
    return Redacted.make(Encoding.encodeHex(bytes))
  })

  const randomId = <SchemaType extends Schema.Top>(schema: SchemaType) =>
    cryptoService.randomUUIDv7.pipe(
      Effect.mapError(() => new AuthCryptoError()),
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.mapError(() => new AuthCryptoError())
        )
      )
    )

  const hashCredential = Effect.fn("Auth.hashCredential")(function*(
    credential: Redacted.Redacted<string>
  ) {
    const bytes = yield* Effect.fromResult(Encoding.decodeHex(Redacted.value(credential))).pipe(
      Effect.mapError(() => new CredentialRejectedError())
    )
    if (bytes.byteLength !== TOKEN_BYTES) return yield* new CredentialRejectedError()
    const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
      Effect.mapError(() => new AuthCryptoError())
    )
    return Encoding.encodeHex(digest)
  })

  const issueValues = Effect.fn("Auth.issuePairingValues")(function*(input: {
    readonly workspaceId: WorkspaceId
    readonly actor: Actor
    readonly permission: Role
    readonly purpose: "first-run" | "device" | "recovery"
    readonly issuedBySessionId: SessionIdType | null
  }) {
    const createdAt = yield* now
    const pairingCodeId = yield* randomId(PairingCodeId)
    const pairingCode = yield* randomSecret()
    const codeHash = yield* hashCredential(pairingCode)
    return {
      record: {
        ...input,
        pairingCodeId,
        codeHash,
        createdAt,
        expiresAt: DateTime.add(createdAt, { minutes: PAIRING_CODE_LIFETIME_MINUTES })
      },
      pairingCode
    }
  })

  const authenticateRecord = Effect.fn("Auth.authenticateRecord")(function*(
    sessionToken: Redacted.Redacted<string>
  ) {
    const tokenHash = yield* hashCredential(sessionToken)
    const observedAt = yield* now
    return yield* repository.authenticate({
      tokenHash,
      now: observedAt,
      idleExpiresAt: DateTime.add(observedAt, { hours: SESSION_IDLE_LIFETIME_HOURS })
    })
  })

  const requireOwner = Effect.fn("Auth.requireOwner")(function*(
    sessionToken: Redacted.Redacted<string>
  ) {
    const authenticated = yield* authenticateRecord(sessionToken)
    if (authenticated.summary.permission !== "workspace-owner") {
      return yield* new AuthPermissionDeniedError()
    }
    return authenticated.summary
  })

  return {
    bootstrapOwnerPairing: Effect.fn("Auth.bootstrapOwnerPairing")(function*(input: {
      readonly workspaceId: WorkspaceId
      readonly actor: Actor
    }) {
      const values = yield* issueValues({
        ...input,
        permission: "workspace-owner",
        purpose: "first-run",
        issuedBySessionId: null
      })
      const summary = yield* repository.issueFirstRun(values.record)
      return { pairingCode: values.pairingCode, summary }
    }),

    issuePairingCode: Effect.fn("Auth.issuePairingCode")(function*(
      ownerSessionToken: Redacted.Redacted<string>,
      input: { readonly actor: Actor; readonly permission: Role }
    ) {
      const owner = yield* requireOwner(ownerSessionToken)
      const values = yield* issueValues({
        ...input,
        workspaceId: owner.workspaceId,
        purpose: "device",
        issuedBySessionId: owner.sessionId
      })
      const summary = yield* repository.issue(values.record)
      return { pairingCode: values.pairingCode, summary }
    }),

    consumePairingCode: Effect.fn("Auth.consumePairingCode")(function*(
      pairingCode: Redacted.Redacted<string>
    ) {
      const codeHash = yield* hashCredential(pairingCode)
      const createdAt = yield* now
      const sessionId = yield* randomId(SessionId)
      const sessionToken = yield* randomSecret()
      const csrfToken = yield* randomSecret()
      const session = yield* repository.consume({
        codeHash,
        now: createdAt,
        session: {
          sessionId,
          tokenHash: yield* hashCredential(sessionToken),
          csrfHash: yield* hashCredential(csrfToken),
          createdAt,
          idleExpiresAt: DateTime.add(createdAt, { hours: SESSION_IDLE_LIFETIME_HOURS }),
          absoluteExpiresAt: DateTime.add(createdAt, { days: SESSION_ABSOLUTE_LIFETIME_DAYS })
        }
      })
      return { csrfToken, session, sessionToken }
    }),

    authenticate: Effect.fn("Auth.authenticate")(function*(
      sessionToken: Redacted.Redacted<string>
    ) {
      return (yield* authenticateRecord(sessionToken)).summary
    }),

    authorizeMutation: Effect.fn("Auth.authorizeMutation")(function*(
      sessionToken: Redacted.Redacted<string>,
      csrfToken: Redacted.Redacted<string>
    ) {
      const authenticated = yield* authenticateRecord(sessionToken)
      const actualHash = yield* hashCredential(csrfToken)
      const actual = yield* Effect.fromResult(Encoding.decodeHex(actualHash)).pipe(
        Effect.mapError(() => new CredentialRejectedError())
      )
      const expected = yield* Effect.fromResult(Encoding.decodeHex(authenticated.csrfHash)).pipe(
        Effect.mapError(() => new CredentialRejectedError())
      )
      if (!fixedTimeEqual(actual, expected)) return yield* new CredentialRejectedError()
      return authenticated.summary
    }),

    listSessions: Effect.fn("Auth.listSessions")(function*(
      ownerSessionToken: Redacted.Redacted<string>
    ) {
      const owner = yield* requireOwner(ownerSessionToken)
      return yield* repository.listSessions(owner.workspaceId)
    }),

    revokeSession: Effect.fn("Auth.revokeSession")(function*(
      ownerSessionToken: Redacted.Redacted<string>,
      sessionId: SessionIdType
    ) {
      const owner = yield* requireOwner(ownerSessionToken)
      yield* repository.revokeSession({ workspaceId: owner.workspaceId, sessionId, now: yield* now })
    }),

    logout: Effect.fn("Auth.logout")(function*(sessionToken: Redacted.Redacted<string>) {
      const tokenHash = yield* hashCredential(sessionToken)
      yield* repository.logout(tokenHash, yield* now)
    }),

    listPairingCodes: Effect.fn("Auth.listPairingCodes")(function*(
      ownerSessionToken: Redacted.Redacted<string>
    ) {
      const owner = yield* requireOwner(ownerSessionToken)
      return yield* repository.listPairingCodes(owner.workspaceId)
    }),

    revokePairingCode: Effect.fn("Auth.revokePairingCode")(function*(
      ownerSessionToken: Redacted.Redacted<string>,
      pairingCodeId: PairingCodeIdType
    ) {
      const owner = yield* requireOwner(ownerSessionToken)
      yield* repository.revokePairingCode({
        workspaceId: owner.workspaceId,
        pairingCodeId,
        now: yield* now
      })
    })
  }
})

/** Authentication/session application service. Raw credentials stay redacted at its boundary. */
export class Auth extends Context.Service<Auth, Effect.Success<typeof makeAuth>>()(
  "@knpkv/control-center/server/auth/Auth"
) {
  /** Layer requiring the private auth repository plus Effect Crypto and Clock services. */
  static readonly layer = Layer.effect(Auth, makeAuth)
}

/** Build a standalone Auth service from persistence configuration. */
export const authLayer = (persistenceConfigInput: unknown) => {
  const database = databaseLayer(persistenceConfigInput)
  const quarantine = QuarantineRepository.layer.pipe(Layer.provide(database))
  const repository = AuthRepository.layer.pipe(
    Layer.provide(Layer.merge(database, quarantine))
  )
  return Auth.layer.pipe(Layer.provide(repository))
}
