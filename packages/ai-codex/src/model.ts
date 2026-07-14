import type * as Duration from "effect/Duration"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as AiModel from "effect/unstable/ai/Model"
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { makeLanguageModel } from "./internal/languageModel.js"

/** Configuration for a local Codex-backed Effect AI model. */
export interface CodexModelOptions {
  /** Working directory made visible to Codex. */
  readonly cwd: string
  /** Codex executable name or absolute path. Defaults to `codex`. */
  readonly executable?: string
  /** Optional Codex model override. */
  readonly model?: string
  /** Filesystem access granted to Codex. Defaults to `read-only`. */
  readonly access?: "read-only" | "workspace-write"
  /** Maximum duration of one Codex turn. Defaults to two minutes. */
  readonly timeout?: Duration.Input
  /** Maximum bytes accepted from Codex stdout. Defaults to 1 MiB. */
  readonly maxOutputBytes?: number
  /** Maximum bytes accepted from Codex stderr. Defaults to 64 KiB. */
  readonly maxStderrBytes?: number
}

/**
 * Creates an Effect AI model backed by an authenticated local Codex CLI.
 *
 * Each Effect AI generation is isolated in an ephemeral Codex invocation.
 * Toolkits and file prompt parts are rejected because the local CLI transport
 * cannot preserve Effect AI's typed tool and file semantics.
 */
export const model = (
  options: CodexModelOptions
): AiModel.Model<
  "codex-cli",
  LanguageModel.LanguageModel,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  AiModel.make(
    "codex-cli",
    options.model ?? "configured-default",
    Layer.effect(LanguageModel.LanguageModel, makeLanguageModel(options))
  )
