/** Framed, bounded patch parsing shared by current-line placement and the actual Rly renderer. @module */
import { type FileDiff, parsePatch } from "@knpkv/rly/diff/patch"
import { createTwoFilesPatch } from "diff"
import { Result, Schema } from "effect"
import type { CodeDiff, CodeDiffContent } from "../host-contract.js"
import { quoteGitPath } from "../internal/git-path.js"
import { canRenderCodeText } from "./components/host-diff-text.js"

export class ReviewDiffFileError extends Schema.TaggedError<ReviewDiffFileError>()("ReviewDiffFileError", {
  reason: Schema.Literals(["wrong_content", "binary", "oversized", "display_limit", "invalid_patch"])
}) {}

/**
 * Consume decoded immutable inventory/content. Check revision/index and display budgets before
 * synchronous diff computation. Preserve Git quoting, prefixes, rename, modes and absent sides;
 * do not repair PatchInvalid or invent mode/line evidence. Return the exact object to render/place.
 */
export const parseReviewDiffFile = (
  file: CodeDiff["files"][number],
  revisionId: string,
  content: CodeDiffContent
): Result.Result<FileDiff, ReviewDiffFileError> => {
  if (content.revisionId !== revisionId || content.fileIndex !== file.index) {
    return Result.fail(new ReviewDiffFileError({ reason: "wrong_content" }))
  }
  if (content.state !== "text") return Result.fail(new ReviewDiffFileError({ reason: content.state }))
  if (!canRenderCodeText(content.before, content.after)) {
    return Result.fail(new ReviewDiffFileError({ reason: "display_limit" }))
  }
  if ([file.beforeMode, file.afterMode].some((mode) => mode !== null && !/^[0-7]{6}$/.test(mode))) {
    return Result.fail(new ReviewDiffFileError({ reason: "invalid_patch" }))
  }
  if (
    (file.status !== "added" && content.before === null) || (file.status !== "deleted" && content.after === null) ||
    (file.status === "added" && content.before !== null && content.before !== "") ||
    (file.status === "deleted" && content.after !== null && content.after !== "") ||
    (file.status === "renamed" && file.previousPath === null)
  ) return Result.fail(new ReviewDiffFileError({ reason: "wrong_content" }))

  const oldPath = file.previousPath ?? file.path
  const newPath = file.path
  const headers = [`diff --git ${quoteGitPath(`a/${oldPath}`)} ${quoteGitPath(`b/${newPath}`)}`]
  if (file.status === "added" && file.afterMode !== null) headers.push(`new file mode ${file.afterMode}`)
  else if (file.status === "deleted" && file.beforeMode !== null) headers.push(`deleted file mode ${file.beforeMode}`)
  else if (file.beforeMode !== null && file.afterMode !== null && file.beforeMode !== file.afterMode) {
    headers.push(`old mode ${file.beforeMode}`, `new mode ${file.afterMode}`)
  }
  if (file.status === "renamed") {
    headers.push(`rename from ${quoteGitPath(oldPath)}`, `rename to ${quoteGitPath(newPath)}`)
  }
  const before = content.before ?? ""
  const after = content.after ?? ""
  const generated = Result.try({
    try: () =>
      before === after ? "" : createTwoFilesPatch(
        file.status === "added" ? "/dev/null" : `a/${oldPath}`,
        file.status === "deleted" ? "/dev/null" : `b/${newPath}`,
        before,
        after,
        "",
        "",
        { context: 3 }
      ),
    catch: () => new ReviewDiffFileError({ reason: "invalid_patch" })
  })
  if (Result.isFailure(generated)) return Result.fail(generated.failure)
  const parsed = parsePatch(`${headers.join("\n")}\n${generated.success}`)
  const parsedFile = parsed._tag === "Patch" ? parsed.patch.files[0] : undefined
  return parsed._tag === "Patch" && parsed.patch.files.length === 1 && parsedFile !== undefined &&
      parsedFile.status === file.status && parsedFile.oldPath === oldPath && parsedFile.newPath === newPath
    ? Result.succeed(parsedFile)
    : Result.fail(new ReviewDiffFileError({ reason: "invalid_patch" }))
}
