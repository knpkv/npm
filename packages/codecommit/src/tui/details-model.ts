import type { ReadClient } from "@knpkv/codecommit-core"

const MAX_RENDERED_LINES = 500
const MAX_RENDERED_LINE_LENGTH = 2_000

export const changedFilePath = (file: ReadClient.CodeCommitChangedFile): string =>
  file.after?.path ?? file.before?.path ?? "unknown"

export const filetypeForPath = (path: string): string | undefined => {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : ""
  const aliases: Record<string, string> = {
    cjs: "javascript",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rs: "rust",
    ts: "typescript",
    tsx: "typescript",
    yaml: "yaml",
    yml: "yaml"
  }
  return aliases[extension] ?? (extension.length > 0 ? extension : undefined)
}

const patchPath = (value: string): string => value.replace(/[\r\n\t]/g, "_")

/** Builds a bounded valid unified patch for OpenTUI's native diff renderable. */
export const buildUnifiedDiff = (
  file: ReadClient.CodeCommitChangedFile,
  beforeText: string,
  afterText: string
): { readonly diff: string; readonly truncated: boolean } => {
  const beforeLines = beforeText.length === 0 ? [] : beforeText.replace(/\n$/, "").split("\n")
  const afterLines = afterText.length === 0 ? [] : afterText.replace(/\n$/, "").split("\n")
  const total = beforeLines.length + afterLines.length
  const beforeBudget = Math.min(beforeLines.length, Math.floor(MAX_RENDERED_LINES / 2))
  const afterBudget = Math.min(afterLines.length, MAX_RENDERED_LINES - beforeBudget)
  const boundedBefore = beforeLines.slice(0, beforeBudget)
  const boundedAfter = afterLines.slice(0, afterBudget)
  const beforePath = patchPath(file.before?.path ?? "/dev/null")
  const afterPath = patchPath(file.after?.path ?? "/dev/null")
  const boundLine = (line: string): string => line.slice(0, MAX_RENDERED_LINE_LENGTH)
  const lines = [
    `--- ${file.before === null ? "/dev/null" : `a/${beforePath}`}`,
    `+++ ${file.after === null ? "/dev/null" : `b/${afterPath}`}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...boundedBefore.map((line) => `-${boundLine(line)}`),
    ...boundedAfter.map((line) => `+${boundLine(line)}`)
  ]
  const truncated = total > boundedBefore.length + boundedAfter.length ||
    [...beforeLines, ...afterLines].some((line) => line.length > MAX_RENDERED_LINE_LENGTH)
  if (truncated) lines.push("+… diff preview truncated; checkout the exact head for the complete file")
  return { diff: lines.join("\n"), truncated }
}
