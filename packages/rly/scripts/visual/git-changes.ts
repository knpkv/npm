import * as Data from "effect/Data"
import type { ChangedFile, ChangedFileStatus } from "./classify-changes.js"

/** Raised when Git's NUL-delimited name-status output is incomplete or invalid. */
export class GitChangesError extends Data.TaggedError("GitChangesError")<{
  readonly reason: string
}> {
  override get message(): string {
    return this.reason
  }
}

const simpleStatus = (code: string): ChangedFileStatus => {
  if (code === "A") return "added"
  if (code === "M") return "modified"
  if (code === "D") return "deleted"
  if (code === "T") return "type-changed"
  if (code === "U") return "unmerged"
  return "unknown"
}

const nextToken = (tokens: ReadonlyArray<string>, index: number, label: string): string => {
  const token = tokens[index]
  if (token === undefined || token.length === 0) {
    throw new GitChangesError({ reason: `Missing ${label}` })
  }
  return token
}

/** Parse `git diff --name-status -z` without losing spaces or newlines in paths. */
export const parseGitNameStatus = (input: string): ReadonlyArray<ChangedFile> => {
  if (input.length === 0) return []
  const tokens = input.split("\0")
  if (tokens.at(-1) !== "") throw new GitChangesError({ reason: "Git output is not NUL terminated" })
  tokens.pop()

  const changes: Array<ChangedFile> = []
  let index = 0
  while (index < tokens.length) {
    const rawStatus = nextToken(tokens, index, "change status")
    index += 1
    if (!/^[ACDMRTUXB][0-9]*$/.test(rawStatus)) {
      throw new GitChangesError({ reason: `Unsupported change status: ${rawStatus}` })
    }
    const code = rawStatus.slice(0, 1)
    if (code === "R" || code === "C") {
      const previousPath = nextToken(tokens, index, "previous path")
      const path = nextToken(tokens, index + 1, "changed path")
      index += 2
      changes.push({
        path,
        previousPath,
        status: code === "R" ? "renamed" : "copied"
      })
      continue
    }
    const path = nextToken(tokens, index, "changed path")
    index += 1
    changes.push({ path, status: simpleStatus(code) })
  }
  return changes
}
