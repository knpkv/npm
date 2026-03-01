/**
 * Sandbox plugin system — extensible lifecycle hooks.
 *
 * Plugins execute sequentially in registration order.
 * Plugin failures are non-fatal (logged, sandbox continues).
 *
 * @module
 */
import { Effect, Ref } from "effect"
import type { PullRequestId, RepositoryName, SandboxId } from "../Domain.js"

export interface SandboxContext {
  readonly sandboxId: SandboxId
  readonly containerId: string
  readonly workspacePath: string
  readonly port: number
  readonly pr: {
    readonly id: PullRequestId
    readonly repositoryName: RepositoryName
    readonly sourceBranch: string
  }
}

export interface SandboxPlugin {
  readonly name: string
  readonly onSandboxCreate?: (ctx: SandboxContext) => Effect.Effect<void>
  readonly onSandboxReady?: (ctx: SandboxContext) => Effect.Effect<void>
  readonly onSandboxDestroy?: (ctx: SandboxContext) => Effect.Effect<void>
}

export class PluginService extends Effect.Service<PluginService>()("PluginService", {
  effect: Effect.gen(function*() {
    const plugins = yield* Ref.make<ReadonlyArray<SandboxPlugin>>([])

    return {
      register: (plugin: SandboxPlugin) =>
        Ref.update(plugins, (ps) => [...ps, plugin]).pipe(
          Effect.tap(() => Effect.logInfo(`Plugin registered: ${plugin.name}`))
        ),

      executeHook: (hook: "onSandboxCreate" | "onSandboxReady" | "onSandboxDestroy", ctx: SandboxContext) =>
        Ref.get(plugins).pipe(
          Effect.flatMap((ps) =>
            Effect.forEach(ps, (p) => {
              const fn = p[hook]
              if (!fn) return Effect.void
              return fn(ctx).pipe(
                Effect.catchAllCause((cause) => Effect.logWarning(`Plugin ${p.name} ${hook} failed`, cause))
              )
            }, { discard: true })
          ),
          Effect.withSpan(`PluginService.${hook}`, { captureStackTrace: false })
        ),

      listPlugins: () => Ref.get(plugins).pipe(Effect.map((ps) => ps.map((p) => p.name)))
    } as const
  })
}) {}
