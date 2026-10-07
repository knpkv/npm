/**
 * Relay: the agent harness every product mounts.
 *
 * @since 0.1.0
 */
export { claudeCodeBackend, codexCliBackend } from "./backends.js"
export type { CliBackendOptions } from "./backends.js"
export {
  layer,
  make,
  RelayBackendNotConfigured,
  RelayBackendUnavailable,
  RelayDecisionNotPending,
  RelayHarness,
  RelayRunNotActive,
  RelayStoreFailed,
  RelayStoreLocked
} from "./harness.js"
export type { MessageContext, RelayBackend, RelayHarnessOptions, RelayHarnessService, SendOptions } from "./harness.js"
export {
  BackendStatus,
  BackendUnavailableCause,
  CapabilityAccess,
  DecisionState,
  ObjectRef,
  objectRefKey,
  RelayBackendId,
  RelayEvent,
  RelayProduct,
  SessionInfo,
  SessionTool,
  WriteReceipt
} from "./model.js"
export { register } from "./registry.js"
export type { DisplayOptions, Gate, RegisteredCapability } from "./registry.js"
