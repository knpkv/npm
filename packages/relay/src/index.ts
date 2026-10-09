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
  RelayDecisionNotPending,
  RelayHarness,
  RelayStoreFailed,
  RelayStoreLinked,
  RelayStoreLocked
} from "./harness.js"
export type { RelayBackend, RelayHarnessOptions, RelayHarnessService } from "./harness.js"
export {
  BackendStatus,
  BackendUnavailableCause,
  CapabilityEffect,
  defineCapability,
  ObjectRef,
  objectRefKey,
  PendingAction,
  RelayBackendId,
  RelayEvent,
  RelayProduct,
  SessionTool
} from "./model.js"
export type { Capability } from "./model.js"
export { CapabilityFailed, CapabilityInputInvalid, CapabilityOutputInvalid, register } from "./registry.js"
export type { CapabilityResult, RegisteredCapability } from "./registry.js"
