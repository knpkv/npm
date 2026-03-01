/**
 * Claude Code sandbox plugin.
 *
 * Installs Claude Code CLI inside the sandbox container on ready.
 * Depends on DockerService being available in the sandbox context.
 *
 * @module
 */
import { Effect } from "effect"
import type { SandboxPlugin } from "../PluginService.js"

/**
 * Creates the Claude Code plugin.
 *
 * Takes a docker exec function to avoid dependency resolution issues —
 * the plugin runs inside SandboxService which already has DockerService.
 */
export const makeClaudeCodePlugin = (
  dockerExec: (containerId: string, cmd: ReadonlyArray<string>) => Effect.Effect<void>
): SandboxPlugin => ({
  name: "claude-code",
  onSandboxReady: (ctx) =>
    Effect.gen(function*() {
      yield* Effect.logInfo(`Installing Claude Code CLI in sandbox ${ctx.sandboxId}`)
      yield* dockerExec(ctx.containerId, ["npm", "install", "-g", "@anthropic-ai/claude-code"])
      yield* Effect.logInfo(`Claude Code CLI installed in sandbox ${ctx.sandboxId}`)
    }).pipe(
      Effect.catchAllCause((cause) =>
        Effect.logWarning(`Claude Code plugin install failed for sandbox ${ctx.sandboxId}`, cause)
      )
    )
})
