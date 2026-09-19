/**
 * From the three inputs to what the page shows: the coverage check plannotator also
 * enforces, then every Issue resolved to the diff line it sits on, or to the general block
 * when the review pointed outside the diff.
 */
import { type FileDiff, findFile, type Patch } from "@knpkv/rly/diff/patch"
import type { Findings, Guide, GuideSection, Issue, Severity } from "./model.js"

// ── Coverage ──────────────────────────────────────────────────────────────────

/**
 * Every file in the patch appears in exactly one section or in `unplacedFiles`, and the
 * guide names no file the patch lacks. Issue ids are unique. Returns every problem, not the
 * first, so one fix-up round is enough.
 */
export const coverageProblems = (
  guide: Guide,
  patch: Patch,
  findings: Findings
): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const seen = new Map<string, Array<string>>()
  const place = (path: string, where: string) => {
    const file = findFile(patch, path)
    if (file === undefined) {
      problems.push(`"${path}" (${where}) is not in the patch`)
      return
    }
    const owners = seen.get(file.path) ?? []
    owners.push(where)
    seen.set(file.path, owners)
  }
  guide.sections.forEach((section, index) => {
    for (const diff of section.diffs) place(diff.file, `section ${index + 1} "${section.title}"`)
  })
  for (const path of guide.unplacedFiles) place(path, "unplacedFiles")

  for (const file of patch.files) {
    const owners = seen.get(file.path) ?? []
    if (owners.length === 0) problems.push(`"${file.path}" is in the patch but in no section`)
    if (owners.length > 1) problems.push(`"${file.path}" is placed more than once: ${owners.join(", ")}`)
  }

  const ids = new Set<number>()
  for (const issue of findings.issues) {
    if (ids.has(issue.id)) problems.push(`Issue ${issue.id} appears twice in findings`)
    ids.add(issue.id)
  }
  return problems
}

// ── Anchoring ─────────────────────────────────────────────────────────────────

/** An Issue that sits on a line the patch shows. */
export interface Anchored {
  readonly kind: "anchored"
  readonly issue: Issue
  readonly file: FileDiff
  readonly side: "new" | "old"
  readonly line: number
}

/** An Issue the diff has no line for: no line given, line outside every hunk, or file not in the patch. */
export interface Unanchored {
  readonly kind: "general"
  readonly issue: Issue
  readonly reason: "no-line" | "outside-hunks" | "file-not-in-patch"
}

export type Placed = Anchored | Unanchored

export const anchor = (patch: Patch, issue: Issue): Placed => {
  const file = findFile(patch, issue.file)
  if (file === undefined) return { kind: "general", issue, reason: "file-not-in-patch" }
  if (issue.line === undefined) return { kind: "general", issue, reason: "no-line" }
  const side = issue.side ?? "new"
  const hit = file.hunks.some((hunk) =>
    hunk.lines.some((line) => (side === "new" ? line.newNo : line.oldNo) === issue.line)
  )
  return hit
    ? { kind: "anchored", issue, file, side, line: issue.line }
    : { kind: "general", issue, reason: "outside-hunks" }
}

export const placeAll = (patch: Patch, findings: Findings): ReadonlyArray<Placed> =>
  findings.issues.map((issue) => anchor(patch, issue))

// ── Lookups the renderer uses ─────────────────────────────────────────────────

export const SEVERITIES: ReadonlyArray<Severity> = ["P1", "P2", "P3", "P4"]

export const bySeverity = (a: Issue, b: Issue): number =>
  SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.id - b.id

/** Issues on the given file, keyed `${side}:${line}`, for the diff renderer. */
export const anchorsFor = (placed: ReadonlyArray<Placed>, file: FileDiff): Map<string, Array<Issue>> => {
  const map = new Map<string, Array<Issue>>()
  for (const entry of placed) {
    if (entry.kind !== "anchored" || entry.file.path !== file.path) continue
    const key = `${entry.side}:${entry.line}`
    map.set(key, [...(map.get(key) ?? []), entry.issue])
  }
  return map
}

/** Highest severity among the Issues anchored in a section's files, for its badge. */
export const sectionSeverity = (
  section: GuideSection,
  placed: ReadonlyArray<Placed>,
  patch: Patch
): Severity | undefined => {
  const paths = new Set(
    section.diffs.flatMap((diff) => {
      const file = findFile(patch, diff.file)
      return file === undefined ? [] : [file.path]
    })
  )
  const issues = placed
    .filter((entry) => entry.kind === "anchored" && paths.has(entry.file.path))
    .map((entry) => entry.issue)
    .sort(bySeverity)
  return issues[0]?.severity
}

/** Which section a placed file belongs to, for the general block's back-links. */
export const sectionOf = (guide: Guide, patch: Patch, path: string): number | undefined => {
  const file = findFile(patch, path)
  const index = guide.sections.findIndex((section) =>
    section.diffs.some((diff) => file === undefined ? diff.file === path : findFile(patch, diff.file) === file)
  )
  return index === -1 ? undefined : index
}
