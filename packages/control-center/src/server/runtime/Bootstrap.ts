import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"

import type { Actor } from "../../domain/actors.js"
import type { WorkspaceId } from "../../domain/identifiers.js"
import { Auth } from "../auth/Auth.js"
import type { AuthCryptoError, AuthPersistenceError, CredentialRejectedError } from "../auth/errors.js"
import { Persistence, type PersistenceOperationFailure } from "../persistence/Persistence.js"
import type { WorkspaceName } from "../persistence/repositories/models.js"

/** Startup-owned workspace and first owner identity. */
export interface ControlCenterBootstrapOptions {
  readonly workspaceId: WorkspaceId
  readonly workspaceName: WorkspaceName
  readonly owner: Actor
}

/** Secret-safe startup outcome retained for a future terminal presenter. */
export type ControlCenterBootstrapState =
  | { readonly _tag: "disabled" }
  | { readonly _tag: "already-initialized"; readonly workspaceId: WorkspaceId }
  | {
    readonly _tag: "pairing-issued"
    readonly workspaceId: WorkspaceId
    readonly pairingCode: Redacted.Redacted<string>
  }

/** Startup failures possible while ensuring durable workspace and authentication state. */
export type ControlCenterBootstrapError =
  | AuthCryptoError
  | AuthPersistenceError
  | CredentialRejectedError
  | PersistenceOperationFailure

/** Startup bootstrap result available to a future CLI without implicit terminal output. */
export class ControlCenterBootstrap extends Context.Service<
  ControlCenterBootstrap,
  ControlCenterBootstrapState
>()("@knpkv/control-center/server/runtime/ControlCenterBootstrap") {}

const ensureWorkspace = Effect.fn("ControlCenterBootstrap.ensureWorkspace")(function*(
  options: ControlCenterBootstrapOptions
) {
  const persistence = yield* Persistence
  return yield* persistence.workspaces.get(options.workspaceId).pipe(
    Effect.catchTag("RecordNotFoundError", () =>
      Effect.gen(function*() {
        const createdAt = yield* DateTime.now
        return yield* persistence.workspaces.create(options.workspaceId, {
          displayName: options.workspaceName,
          createdAt
        }).pipe(
          Effect.catchTag("RecordAlreadyExistsError", () => persistence.workspaces.get(options.workspaceId))
        )
      }))
  )
})

/** Ensure the configured workspace and issue its first owner code at most once. */
export const makeControlCenterBootstrap: (
  options: ControlCenterBootstrapOptions
) => Effect.Effect<
  ControlCenterBootstrapState,
  ControlCenterBootstrapError,
  Auth | Persistence
> = Effect.fn("ControlCenterBootstrap.make")(function*(options: ControlCenterBootstrapOptions) {
  yield* ensureWorkspace(options)
  const auth = yield* Auth
  return yield* auth.bootstrapOwnerPairing({
    workspaceId: options.workspaceId,
    actor: options.owner
  }).pipe(
    Effect.map(({ pairingCode }) => ({
      _tag: "pairing-issued",
      workspaceId: options.workspaceId,
      pairingCode
    } satisfies ControlCenterBootstrapState)),
    Effect.catchTag("FirstRunPairingAlreadyIssuedError", () =>
      Effect.succeed(
        {
          _tag: "already-initialized",
          workspaceId: options.workspaceId
        } satisfies ControlCenterBootstrapState
      ))
  )
})

/** Build the optional bootstrap result as a startup service. */
export const controlCenterBootstrapLayer = (
  options: ControlCenterBootstrapOptions | null
): Layer.Layer<ControlCenterBootstrap, ControlCenterBootstrapError, Auth | Persistence> =>
  options === null
    ? Layer.succeed(ControlCenterBootstrap, { _tag: "disabled" })
    : Layer.effect(ControlCenterBootstrap, makeControlCenterBootstrap(options))
