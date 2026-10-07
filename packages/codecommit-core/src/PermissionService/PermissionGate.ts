/**
 * @title PermissionGate — abstract "ask the user" interface
 *
 * Context.Service so different environments can
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
  category: Schema.Literals(["read", "write"]),
  context: Schema.String
}) {}

export type PermissionResponse = "allow_once" | "always_allow" | "deny"

/**
 * `standing` re-reads the saved permission once the prompt is registered. A call that checked its
 * permission just before a standing grant (or refusal) was saved, and registered just after the grant
 * released the waiting prompts, answers itself from it instead of waiting for nobody.
 */
export interface PermissionRequestOptions {
  readonly standing?: Effect.Effect<PermissionResponse | undefined>
}

// Blocks the calling fiber until user responds or 30s timeout.
// Returns the response, or fails with PermissionDeniedError.
export class PermissionGate extends Context.Service<
  PermissionGate,
  {
    readonly request: (
      prompt: PermissionPrompt,
      options?: PermissionRequestOptions
    ) => Effect.Effect<PermissionResponse, PermissionDeniedError>
  }
>()("@knpkv/codecommit-core/PermissionGate") {}
