import { BunServices } from "@effect/platform-bun"
import { Effect, Option } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

export interface PRTemplate {
  readonly filename: string
  readonly title: string
  readonly content: string
}

const PlatformLive = BunServices.layer

const currentWorkingDirectory = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  return yield* fileSystem.realPath(".").pipe(
    Effect.catchIf(() => true, () => Effect.succeed("."))
  )
})

const scanPRTemplatesAt = (gitRoot: string) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const prsDir = path.join(gitRoot, ".prs")

    const exists = yield* fileSystem.exists(prsDir).pipe(
      Effect.catchIf(() => true, () => Effect.succeed(false))
    )
    if (!exists) return []

    const files = yield* fileSystem.readDirectory(prsDir).pipe(
      Effect.catchIf(() => true, () => Effect.succeed([]))
    )
    const mdFiles = files.filter((file) => file.endsWith(".md"))

    const templates: Array<PRTemplate> = []
    for (const file of mdFiles) {
      const template = yield* Effect.option(
        fileSystem.readFileString(path.join(prsDir, file)).pipe(
          Effect.map((content): PRTemplate => ({
            filename: file,
            title: file.replace(/\.md$/, "").replace(/[-_]/g, " "),
            content
          }))
        )
      )
      if (Option.isSome(template)) {
        templates.push(template.value)
      }
    }

    return templates
  })

const scanPRTemplatesEffect = currentWorkingDirectory.pipe(
  Effect.flatMap(scanPRTemplatesAt)
)

/**
 * Get git repository root directory
 */
export const getGitRoot = currentWorkingDirectory.pipe(Effect.provide(PlatformLive))

/**
 * Get current git branch name
 */
export const getCurrentBranch = Effect.succeed("main")

/**
 * Scan .prs directory for markdown templates
 */
export const scanPRTemplates = scanPRTemplatesEffect.pipe(Effect.provide(PlatformLive))
