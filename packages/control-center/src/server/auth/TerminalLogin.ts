/**
 * In-process terminal sign-in, separate from browser administration and destructive recovery.
 * Only the owner-private control bearer route may invoke this issuer. It stores a digest of a
 * 60-second, single-use owner code and never revokes sessions or outstanding codes.
 * @module
 */
import { hashCredential, issuePairingCode } from "@knpkv/browser-pairing"
import { Clock, Context, Crypto, DateTime, Effect, Layer, Schema } from "effect"
import type { Actor } from "../../domain/actors.js"
import type { WorkspaceId } from "../../domain/identifiers.js"
import { AuthRepository } from "./AuthRepository.js"
import { AuthCryptoError } from "./errors.js"
import { PairingCodeId } from "./models.js"

/** Fixed startup identity, never accepted from an HTTP request or browser input. */
export interface TerminalLoginIdentity {
  readonly workspaceId: WorkspaceId
  readonly owner: Extract<Actor, { readonly _tag: "human" }>
}

const makeTerminalLogin = Effect.fn("TerminalLogin.make")(function*(identity: TerminalLoginIdentity) {
  const repository = yield* AuthRepository
  const cryptoService = yield* Crypto.Crypto
  const mint = Effect.gen(function*() {
    const createdAt = DateTime.makeUnsafe(yield* Clock.currentTimeMillis)
    const pairingCodeId = yield* cryptoService.randomUUIDv7.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PairingCodeId)),
      Effect.mapError(() => new AuthCryptoError())
    )
    const pairingCode = yield* issuePairingCode().pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(() => new AuthCryptoError())
    )
    const codeHash = yield* hashCredential(pairingCode).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(() => new AuthCryptoError())
    )
    const summary = yield* repository.issue({
      workspaceId: identity.workspaceId,
      actor: identity.owner,
      permission: "workspace-owner",
      purpose: "device",
      issuedBySessionId: null,
      pairingCodeId,
      codeHash,
      createdAt,
      expiresAt: DateTime.add(createdAt, { seconds: 60 })
    })
    return { pairingCode, summary }
  })
  return { mint }
})

/** Credential-bearing issuance result. This private service is not browser-facing Auth. */
export class TerminalLogin
  extends Context.Service<TerminalLogin, Effect.Success<ReturnType<typeof makeTerminalLogin>>>()(
    "@knpkv/control-center/server/auth/TerminalLogin"
  )
{
  static readonly layer = (identity: TerminalLoginIdentity) => Layer.effect(TerminalLogin, makeTerminalLogin(identity))
}
