/** Reports expose only safe contention metadata; the server's SQLite cause never crosses HTTP. */
import { ConnectStoreBusyError } from "@knpkv/herdr-connect"
import { Schema } from "effect"

export const RelayStoreBusyFailureBody = Schema.Struct({
  error: Schema.Literal("ConnectStoreBusyError"),
  operation: ConnectStoreBusyError.fields.operation,
  timeoutMillis: ConnectStoreBusyError.fields.timeoutMillis
})
