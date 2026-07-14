import type * as Effect from "effect/Effect"

import type {
  AuthorizedPluginActionV1,
  PluginActionCancellationRequestV1,
  PluginActionCancellationResultV1,
  PluginActionDispatchResultV1,
  PluginActionPreflightV1,
  PluginActionReconciliationRequestV1,
  PluginActionReconciliationResultV1
} from "../../domain/plugins/actions.js"
import type { PluginFailure } from "./failures.js"

/**
 * Adapter implementation shape for governed provider writes. This interface
 * carries no live Context tag and grants no authority to invoke an executor.
 */
export interface AuthorizedPluginExecutorV1 {
  readonly preflight: (
    request: AuthorizedPluginActionV1
  ) => Effect.Effect<PluginActionPreflightV1, PluginFailure>
  readonly executeAuthorizedAction: (
    request: AuthorizedPluginActionV1
  ) => Effect.Effect<PluginActionDispatchResultV1, PluginFailure>
  readonly requestCancellation: (
    request: PluginActionCancellationRequestV1
  ) => Effect.Effect<PluginActionCancellationResultV1, PluginFailure>
  readonly reconcile: (
    request: PluginActionReconciliationRequestV1
  ) => Effect.Effect<PluginActionReconciliationResultV1, PluginFailure>
}
