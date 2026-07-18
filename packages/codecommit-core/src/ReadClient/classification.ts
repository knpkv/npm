/** Deterministic classification for bounded CodeCommit file content. @module */
import * as Schema from "effect/Schema"

/** Conservative binary/generated facts derived without provider-specific guesses. */
export class CodeCommitFileClassification extends Schema.Class<CodeCommitFileClassification>(
  "CodeCommitFileClassification"
)({
  binary: Schema.Boolean,
  generated: Schema.Boolean
}) {}

const generatedBasenames = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock"
])

const generatedPath = (path: string): boolean => {
  const normalized = path.replaceAll("\\", "/").toLowerCase()
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1)
  return generatedBasenames.has(basename) ||
    normalized.split("/").includes("generated") ||
    basename.includes(".generated.") ||
    basename.endsWith(".min.css") ||
    basename.endsWith(".min.js") ||
    basename.endsWith(".map")
}

/** Classify one already-bounded blob using stable, intentionally conservative signals. */
export const classifyCodeCommitFile = (
  path: string,
  bytes: Uint8Array<ArrayBufferLike>
): CodeCommitFileClassification =>
  new CodeCommitFileClassification({
    binary: bytes.includes(0),
    generated: generatedPath(path)
  })
