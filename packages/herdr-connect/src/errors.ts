import { Schema } from "effect"

export class ConnectTargetError extends Schema.TaggedError<ConnectTargetError>()(
  "ConnectTargetError",
  { reason: Schema.Literals(["malformed", "unknown"]) }
) {}

export class ConnectBootstrapError extends Schema.TaggedError<ConnectBootstrapError>()(
  "ConnectBootstrapError",
  { detail: Schema.String }
) {}

export class ConnectPeerError extends Schema.TaggedError<ConnectPeerError>()(
  "ConnectPeerError",
  {
    cause: Schema.Defect(),
    host: Schema.String,
    reason: Schema.Literals(["offline", "unavailable", "timeout", "request_failed", "invalid_response"])
  }
) {}

export class ConnectAgentIdError extends Schema.TaggedError<ConnectAgentIdError>()(
  "ConnectAgentIdError",
  { cause: Schema.Defect() }
) {}

export class ConnectRelationshipError extends Schema.TaggedError<ConnectRelationshipError>()(
  "ConnectRelationshipError",
  {
    detail: Schema.String,
    reason: Schema.Literals([
      "malformed",
      "stale",
      "cyclic",
      "missing_parent",
      "cross_host",
      "ambiguous_ownership"
    ])
  }
) {}

export class ConnectRelationshipStoreError extends Schema.TaggedError<ConnectRelationshipStoreError>()(
  "ConnectRelationshipStoreError",
  { cause: Schema.Defect(), operation: Schema.String }
) {}

export class TerminalAgentNotFoundError extends Schema.TaggedError<TerminalAgentNotFoundError>()(
  "TerminalAgentNotFoundError",
  { agentId: Schema.String, host: Schema.String }
) {}

export class TerminalBusyError extends Schema.TaggedError<TerminalBusyError>()(
  "TerminalBusyError",
  { agentId: Schema.String, host: Schema.String }
) {}

export class TerminalProtocolError extends Schema.TaggedError<TerminalProtocolError>()(
  "TerminalProtocolError",
  { cause: Schema.Defect(), detail: Schema.String }
) {}

export class TerminalTransportError extends Schema.TaggedError<TerminalTransportError>()(
  "TerminalTransportError",
  { cause: Schema.Defect(), detail: Schema.String, operation: Schema.String }
) {}
