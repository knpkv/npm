import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"

import type { PersistedRecordError, PersistenceOperationError } from "../../persistence/errors.js"
import type { PluginRuntimeScope } from "../PluginConnectionMap.js"
import type {
  CurrentPluginRuntimeAuthority,
  PluginRuntimeAuthorityPublicationConflict,
  PluginRuntimeAuthorityToken,
  PluginRuntimeAuthorityUnavailable,
  PublishPluginRuntimeAuthority
} from "./PluginRuntimeAuthority.js"

/** Internal transaction-owned authority source for runtime publication and governed dispatch. */
export interface PluginRuntimeAuthoritySourceV1 {
  readonly publish: (
    input: PublishPluginRuntimeAuthority
  ) => Effect.Effect<
    CurrentPluginRuntimeAuthority,
    PluginRuntimeAuthorityPublicationConflict | PersistedRecordError | PersistenceOperationError
  >
  /**
   * Verify an exact current generation and run database-only work in the same transaction.
   * The callback must not perform provider, filesystem, or network effects.
   */
  readonly transactCurrent: <Success, Failure, Requirements>(
    input: {
      readonly scope: PluginRuntimeScope
      readonly runtimeAuthorityToken: PluginRuntimeAuthorityToken
    },
    use: (
      current: CurrentPluginRuntimeAuthority
    ) => Effect.Effect<Success, Failure, Requirements>
  ) => Effect.Effect<
    Success,
    Failure | PluginRuntimeAuthorityUnavailable | PersistedRecordError | PersistenceOperationError,
    Requirements
  >
}

/** Server-only seam that keeps current-source verification adjacent to database mutations. */
export class PluginRuntimeAuthoritySource extends Context.Service<
  PluginRuntimeAuthoritySource,
  PluginRuntimeAuthoritySourceV1
>()("@knpkv/control-center/internal/PluginRuntimeAuthoritySource") {}
