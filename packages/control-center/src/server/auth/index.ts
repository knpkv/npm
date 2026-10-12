/** Browser Auth and destructive terminal recovery. Non-destructive terminal minting stays private to the owner-bearer runtime route. */
export { Auth, authLayer } from "./Auth.js"
export {
  AuthCryptoError,
  AuthPermissionDeniedError,
  AuthPersistenceError,
  CredentialRejectedError,
  FirstRunPairingAlreadyIssuedError,
  TerminalRecoveryRefusedError
} from "./errors.js"
export {
  type IssuedPairingCode,
  type IssuedSession,
  PAIRING_CODE_LIFETIME_MINUTES,
  PairingCodeId,
  PairingCodeSummary,
  PairingPurpose,
  SESSION_ABSOLUTE_LIFETIME_DAYS,
  SESSION_IDLE_LIFETIME_HOURS,
  SessionId,
  SessionSummary
} from "./models.js"
export { TERMINAL_RECOVERY_CONFIRMATION, TerminalRecovery, terminalRecoveryLayer } from "./TerminalRecovery.js"
