/**
 * @title PermissionGate — abstract "ask the user" interface
 *
 * Context.Tag (not Effect.Service) so different environments can
 * provide different implementations:
 *   - Web: Deferred + SSE push (PermissionGateLive.ts)
 *   - TUI: stdin prompt (future)
 *   - Test: auto-allow Layer
 *
 * Only exposes `request` — the caller's view. The concrete implementation
 * (PermissionGateLive) adds `resolve` and `getFirstPending` for the
 * HTTP handler and SSE builder.
 *
 * @module
 */
import type { Effect } from "effect"
import { Context, Schema } from "effect"
import type { PermissionDeniedError } from "../Errors.js"

// UUID correlates the SSE prompt → client modal → POST response
export class PermissionPrompt extends Schema.Class<PermissionPrompt>("PermissionPrompt")({
  id: Schema.String,
  operation: Schema.String,
  category: Schema.Literal("read", "write"),
  context: Schema.String
}) {}

export type PermissionResponse = "allow_once" | "always_allow" | "deny"

// Blocks the calling fiber until user responds or 30s timeout.
// Returns the response, or fails with PermissionDeniedError.
export class PermissionGate extends Context.Tag("@knpkv/codecommit-core/PermissionGate")<
  PermissionGate,
  {
    readonly request: (prompt: PermissionPrompt) => Effect.Effect<PermissionResponse, PermissionDeniedError>
  }
>() {}
