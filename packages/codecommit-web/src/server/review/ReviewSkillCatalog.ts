/** Bounded discovery of prompt-only review skills from the local Codex environment. @module */
import { Config, Effect, Option, Predicate, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

import { MAXIMUM_RELAY_SKILL_PROMPT_BYTES } from "./ReviewPromptBudget.js"

const MAXIMUM_SKILL_FILES = 256
const MAXIMUM_SKILL_DIRECTORIES = MAXIMUM_SKILL_FILES + 1
const MAXIMUM_SKILL_BYTES = 64 * 1024
const MAXIMUM_SKILL_DEPTH = 8

const builtinSkills: ReadonlyArray<ReviewSkillDefinition> = [
  {
    id: "builtin:pr-review",
    name: "PR Review",
    description: "Broad correctness, security, reliability, tests, and maintainability review.",
    source: "Built in",
    prompt: [
      "Apply the PR Review playbook:",
      "- Review correctness, security, reliability, performance, maintainability, accessibility, architecture, and tests.",
      "- Report only concrete, actionable defects introduced by the supplied patch.",
      "- Assign P1 Critical to broken functionality, security vulnerabilities, or data loss; P2 High to significant bugs, poor UX, or missing validation; P3 Medium to maintainability problems or minor bugs; and P4 Low to style, documentation, or minor improvements.",
      "- Give each issue an exact changed coordinate when the patch supports one.",
      "- Make the summary scannable and the recommendation directly implementable."
    ].join("\n")
  },
  {
    id: "builtin:pr-review-diff",
    name: "PR Diff Review",
    description: "High-confidence diff review with explicit scope and verification evidence.",
    source: "Built in",
    prompt: [
      "Apply the PR Diff Review playbook:",
      "- Stay within the supplied diff and distinguish observed evidence from inference.",
      "- Prefer a smaller set of high-confidence findings over speculative concerns.",
      "- Trace security-sensitive trust boundaries and changed behavioral contracts.",
      "- State what verification supports every finding.",
      "- Because host tools are unavailable, never claim that tests, builds, linters, or runtime checks were executed."
    ].join("\n")
  }
]

export const ReviewSkillMetadata = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  source: Schema.String
})

export type ReviewSkillMetadata = typeof ReviewSkillMetadata.Type

export interface ReviewSkillDefinition extends ReviewSkillMetadata {
  readonly prompt: string
}

export interface SkillRoot {
  readonly label: string
  readonly path: string
}

export class ReviewSkillSelectionError extends Schema.TaggedError<ReviewSkillSelectionError>()(
  "ReviewSkillSelectionError",
  { message: Schema.String }
) {}

const frontMatterValue = (content: string, key: string): string | undefined => {
  const frontMatter = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/u.exec(content)?.[1]
  if (frontMatter === undefined) return undefined
  const match = new RegExp(`^${key}:\\s*(.+)$`, "mu").exec(frontMatter)?.[1]?.trim()
  if (match === undefined || match.length === 0) return undefined
  return match.replace(
    /^(?:"([\s\S]*)"|'([\s\S]*)')$/u,
    (_whole, double, single) => Predicate.isString(double) ? double : Predicate.isString(single) ? single : match
  )
}

const withinRoot = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

const readSkill = Effect.fn("ReviewSkillCatalog.readSkill")(function*(
  root: SkillRoot,
  canonicalRoot: string,
  candidate: string
): Effect.fn.Return<Option.Option<ReviewSkillDefinition>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const canonicalFile = yield* fileSystem.realPath(candidate).pipe(
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none<string>()))
  )
  if (Option.isNone(canonicalFile) || !withinRoot(path, canonicalRoot, canonicalFile.value)) return Option.none()
  const stat = yield* fileSystem.stat(canonicalFile.value).pipe(
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none<FileSystem.File.Info>()))
  )
  if (Option.isNone(stat) || stat.value.type !== "File" || Number(stat.value.size) > MAXIMUM_SKILL_BYTES) {
    return Option.none()
  }
  const content = yield* fileSystem.readFileString(canonicalFile.value).pipe(
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none<string>()))
  )
  if (Option.isNone(content)) return Option.none()
  const directory = path.dirname(path.relative(canonicalRoot, canonicalFile.value)).split(path.sep).join("/")
  const name = frontMatterValue(content.value, "name") ?? path.basename(directory)
  const description = frontMatterValue(content.value, "description") ?? "Local prompt-only review skill."
  return Option.some({
    id: `env:${root.label}:${directory}`,
    name,
    description,
    source: `${root.label}/${directory}`,
    prompt: content.value
  })
})

interface PendingSkillDirectory {
  readonly directory: string
  readonly depth: number
}

const discoverSkillCandidates = Effect.fn("ReviewSkillCatalog.discoverSkillCandidates")(function*(
  canonicalRoot: string
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const pending: Array<PendingSkillDirectory> = [{ directory: canonicalRoot, depth: 0 }]
  const visited = new Set<string>([canonicalRoot])
  const candidates: Array<string> = []
  for (let index = 0; index < pending.length && candidates.length < MAXIMUM_SKILL_FILES; index += 1) {
    const current = pending[index]
    if (current === undefined) break
    const entries = yield* fileSystem.readDirectory(current.directory).pipe(
      Effect.catch(() => Effect.succeed<Array<string>>([]))
    )
    for (const entry of [...entries].sort()) {
      if (candidates.length >= MAXIMUM_SKILL_FILES) break
      const unresolved = path.join(current.directory, entry)
      const canonical = yield* fileSystem.realPath(unresolved).pipe(
        Effect.map(Option.some),
        Effect.catch(() => Effect.succeed(Option.none<string>()))
      )
      if (Option.isNone(canonical) || !withinRoot(path, canonicalRoot, canonical.value)) continue
      const stat = yield* fileSystem.stat(canonical.value).pipe(
        Effect.map(Option.some),
        Effect.catch(() => Effect.succeed(Option.none<FileSystem.File.Info>()))
      )
      if (Option.isNone(stat)) continue
      if (stat.value.type === "File" && path.basename(canonical.value) === "SKILL.md") {
        candidates.push(canonical.value)
        continue
      }
      const nextDepth = current.depth + 1
      if (
        stat.value.type === "Directory" &&
        nextDepth < MAXIMUM_SKILL_DEPTH &&
        visited.size < MAXIMUM_SKILL_DIRECTORIES &&
        !visited.has(canonical.value)
      ) {
        visited.add(canonical.value)
        pending.push({ directory: canonical.value, depth: nextDepth })
      }
    }
  }
  return candidates
})

const discoverRoot = Effect.fn("ReviewSkillCatalog.discoverRoot")(function*(
  root: SkillRoot
): Effect.fn.Return<ReadonlyArray<ReviewSkillDefinition>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  if (!(yield* fileSystem.exists(root.path).pipe(Effect.catch(() => Effect.succeed(false))))) return []
  const canonicalRoot = yield* fileSystem.realPath(root.path).pipe(
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none<string>()))
  )
  if (Option.isNone(canonicalRoot)) return []
  const candidates = yield* discoverSkillCandidates(canonicalRoot.value)
  const skills = yield* Effect.forEach(
    candidates,
    (candidate) => readSkill(root, canonicalRoot.value, candidate),
    { concurrency: 8 }
  )
  return skills.filter(Option.isSome).map((skill) => skill.value)
})

/** Discover the bounded prompt catalog. Repository paths and client-provided paths never participate. */
export const discoverReviewSkills = Effect.fn("ReviewSkillCatalog.discoverReviewSkills")(function*() {
  const path = yield* Path.Path
  const home = yield* Config.string("HOME").pipe(Config.orElse(() => Config.string("USERPROFILE")))
  const codexHome = yield* Config.option(Config.string("CODEX_HOME"))
  const resolvedCodexHome = Option.getOrElse(codexHome, () => path.join(home, ".codex"))
  const roots: ReadonlyArray<SkillRoot> = [
    { label: "agents", path: path.join(home, ".agents", "skills") },
    { label: "codex", path: path.join(resolvedCodexHome, "skills") },
    { label: "plugins", path: path.join(resolvedCodexHome, "plugins", "cache") }
  ]
  return yield* discoverReviewSkillsFromRoots(roots)
})

/** Discover from trusted server-owned roots; exported to prove containment with filesystem fixtures. */
export const discoverReviewSkillsFromRoots = Effect.fn(
  "ReviewSkillCatalog.discoverReviewSkillsFromRoots"
)(function*(roots: ReadonlyArray<SkillRoot>) {
  const discovered = yield* Effect.forEach(roots, discoverRoot, { concurrency: 3 })
  const byId = new Map<string, ReviewSkillDefinition>()
  for (const skill of [...builtinSkills, ...discovered.flat()]) byId.set(skill.id, skill)
  return Array.from(byId.values())
})

/** Resolve only catalog-owned prompt text; unknown or duplicated client ids are ignored. */
export const selectedReviewSkillPrompt = (
  skills: ReadonlyArray<ReviewSkillDefinition>,
  selectedIds: ReadonlyArray<string>
): Effect.Effect<string, ReviewSkillSelectionError> => {
  const selected = new Set(selectedIds)
  const prompt = skills.filter((skill) => selected.has(skill.id)).map((skill) => skill.prompt).join("\n\n")
  const bytes = new TextEncoder().encode(prompt).byteLength
  return bytes <= MAXIMUM_RELAY_SKILL_PROMPT_BYTES
    ? Effect.succeed(prompt)
    : Effect.fail(
      new ReviewSkillSelectionError({
        message: `Selected review skills use ${String(bytes)} UTF-8 bytes; the maximum is ${
          String(MAXIMUM_RELAY_SKILL_PROMPT_BYTES)
        }`
      })
    )
}
