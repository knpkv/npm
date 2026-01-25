import { Effect } from "effect"
import { execSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

export interface PRTemplate {
  readonly filename: string
  readonly title: string
  readonly content: string
}

/**
 * Get git repository root directory
 */
export const getGitRoot = Effect.try(() => {
  const result = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" })
  return result.trim()
}).pipe(Effect.catchAll(() => Effect.succeed(process.cwd())))

/**
 * Get current git branch name
 */
export const getCurrentBranch = Effect.try(() => {
  const result = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" })
  return result.trim()
}).pipe(Effect.catchAll(() => Effect.succeed("main")))

/**
 * Scan .prs directory for markdown templates
 */
export const scanPRTemplates = Effect.gen(function*() {
  const gitRoot = yield* getGitRoot
  const prsDir = path.join(gitRoot, ".prs")

  // Check if directory exists
  const exists = yield* Effect.try(() => fs.existsSync(prsDir))
  if (!exists) return []

  // Read directory
  const files = yield* Effect.try(() => fs.readdirSync(prsDir))
  const mdFiles = files.filter((f) => f.endsWith(".md"))

  // Read each file
  const templates: PRTemplate[] = []
  for (const file of mdFiles) {
    const content = yield* Effect.try(() =>
      fs.readFileSync(path.join(prsDir, file), "utf-8")
    ).pipe(Effect.catchAll(() => Effect.succeed("")))

    if (content) {
      templates.push({
        filename: file,
        title: file.replace(/\.md$/, "").replace(/[-_]/g, " "),
        content
      })
    }
  }

  return templates
})
