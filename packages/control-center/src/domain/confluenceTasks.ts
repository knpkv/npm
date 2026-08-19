import * as Schema from "effect/Schema"

/** One Markdown checkbox that participates in release readiness. */
export const ConfluenceTask = Schema.Struct({
  checked: Schema.Boolean,
  label: Schema.String,
  lineIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lineNumber: Schema.Int.check(Schema.isGreaterThan(0))
})

/** Decoded Markdown checkbox participating in release readiness. */
export type ConfluenceTask = typeof ConfluenceTask.Type

const taskLine = /^(?:\s*(?:(?:[-*+]|\d+\.)\s+)?)(?:\[( |x|X)?\]|\\\[( |x|X)?\\\])\s+(.+?)\s*$/u
const openingFenceLine = /^\s*(`{3,}|~{3,})/u
const closingFenceLine = /^\s*(`{3,}|~{3,})\s*$/u

/** Read task-list checkboxes while ignoring examples inside fenced code blocks. */
export const confluenceTasks = (markdown: string): ReadonlyArray<ConfluenceTask> => {
  const tasks: Array<ConfluenceTask> = []
  let fence: { readonly character: "`" | "~"; readonly length: number } | null = null
  for (const [lineIndex, line] of markdown.split("\n").entries()) {
    const activeFencePattern: RegExp = fence === null ? openingFenceLine : closingFenceLine
    const fenceMatch: RegExpExecArray | null = activeFencePattern.exec(line)
    if (fenceMatch?.[1] !== undefined) {
      const marker: string = fenceMatch[1]
      const character: string | undefined = marker[0]
      if (character === "`" || character === "~") {
        if (fence === null) fence = { character, length: marker.length }
        else if (fence.character === character && marker.length >= fence.length) fence = null
      }
      continue
    }
    if (fence !== null) continue
    const match = taskLine.exec(line)
    if (match?.[3] === undefined) continue
    const marker = match[1] ?? match[2]
    tasks.push({
      checked: marker?.toLocaleLowerCase("en-US") === "x",
      label: match[3],
      lineIndex,
      lineNumber: lineIndex + 1
    })
  }
  return tasks
}

/** Change one already-parsed task without rewriting any surrounding Markdown. */
export const setConfluenceTaskChecked = (
  markdown: string,
  lineIndex: number,
  checked: boolean
): string | null => {
  const lines = markdown.split("\n")
  const line = lines[lineIndex]
  if (line === undefined || !confluenceTasks(line).some((task) => task.lineIndex === 0)) return null
  lines[lineIndex] = line.replace(
    /(\\?)\[(?: |x|X)?(\\?)\]/u,
    (_marker, openingEscape, closingEscape) =>
      `${String(openingEscape)}[${checked ? "x" : " "}${String(closingEscape)}]`
  )
  return lines.join("\n")
}

/** Summarize task completion for UI counts and release gates. */
export const confluenceTaskSummary = (markdown: string) => {
  const tasks = confluenceTasks(markdown)
  const completed = tasks.filter(({ checked }) => checked).length
  return { completed, outstanding: tasks.length - completed, tasks, total: tasks.length }
}
