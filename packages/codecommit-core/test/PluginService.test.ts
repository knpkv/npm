import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Ref } from "effect"
import { PullRequestId, RepositoryName, SandboxId } from "../src/Domain.js"
import { PluginService, type SandboxContext } from "../src/SandboxService/PluginService.js"

const sandboxContext: SandboxContext = {
  sandboxId: SandboxId.make("sandbox-1"),
  containerId: "container-1",
  workspacePath: "/tmp/sandbox-1",
  port: 8080,
  pr: {
    id: PullRequestId.make("42"),
    repositoryName: RepositoryName.make("repository"),
    sourceBranch: "feature"
  }
}

describe("PluginService", () => {
  it.effect("logs a plugin defect and continues with later plugins", () =>
    Effect.gen(function*() {
      const plugins = yield* PluginService
      const observed = yield* Ref.make(0)

      yield* plugins.register({
        name: "defecting",
        onSandboxReady: () => Effect.die("plugin defect")
      })
      yield* plugins.register({
        name: "observer",
        onSandboxReady: () => Ref.update(observed, (count) => count + 1)
      })

      yield* plugins.executeHook("onSandboxReady", sandboxContext)
      expect(yield* Ref.get(observed)).toBe(1)
    }).pipe(Effect.provide(PluginService.Default)))

  it.effect("preserves plugin interruption", () =>
    Effect.gen(function*() {
      const plugins = yield* PluginService
      yield* plugins.register({
        name: "interrupted",
        onSandboxReady: () => Effect.interrupt
      })

      const exit = yield* plugins.executeHook("onSandboxReady", sandboxContext).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }
    }).pipe(Effect.provide(PluginService.Default)))

  it.effect("preserves interruption when a plugin cause also contains a defect", () =>
    Effect.gen(function*() {
      const plugins = yield* PluginService
      const cause = Cause.fromReasons([
        ...Cause.die("plugin defect").reasons,
        ...Cause.interrupt(912).reasons
      ])
      yield* plugins.register({
        name: "interrupted-defect",
        onSandboxReady: () => Effect.failCause(cause)
      })

      const exit = yield* plugins.executeHook("onSandboxReady", sandboxContext).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(["Die", "Interrupt"])
      }
    }).pipe(Effect.provide(PluginService.Default)))
})
