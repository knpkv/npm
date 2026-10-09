/**
 * The two backends Relay supports, each a model turn through the user's own CLI login: Claude Code
 * (Claude Pro/Max or whatever the CLI is signed in with) and Codex (ChatGPT login). Relay never holds a
 * provider credential; the CLI does.
 *
 * Both run with every CLI tool withheld (`prompt-only` / `promptOnly`): the harness runs Relay's tools
 * behind its gate, so the CLI is only ever asked for one structured answer.
 *
 * @module
 */
import * as ClaudeCli from "@knpkv/ai-claude"
import * as CodexCli from "@knpkv/ai-codex"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { RelayBackend } from "./harness.js"

export interface CliBackendOptions {
  /** Working directory the CLI starts in. It reads no files there: every tool is withheld. */
  readonly cwd: string
  /** Model override; omitted means the CLI's configured default. */
  readonly model?: string | undefined
}

/** Claude Code on the user's own login. */
export const claudeCodeBackend = Effect.fn("Relay.claudeCodeBackend")(function*(options: CliBackendOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return {
    id: "claude-code",
    name: "Claude Code",
    model: ClaudeCli.model({ cwd: options.cwd, access: "prompt-only", model: options.model }).pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))
    )
  } satisfies RelayBackend
})

/** Codex on the user's own ChatGPT login. */
export const codexCliBackend = Effect.fn("Relay.codexCliBackend")(function*(options: CliBackendOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fileSystem = yield* FileSystem.FileSystem
  return {
    id: "codex-cli",
    name: "Codex",
    model: CodexCli.model({ cwd: options.cwd, access: "read-only", promptOnly: true, model: options.model }).pipe(
      Layer.provide(Layer.mergeAll(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(FileSystem.FileSystem, fileSystem)
      ))
    )
  } satisfies RelayBackend
})
