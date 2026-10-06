import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { URL } from "node:url"
import ts from "typescript"

import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

class DebtLedgerError extends Data.TaggedError("DebtLedgerError") {
  get message() {
    return this.reason
  }
}

const fail = (reason) => new DebtLedgerError({ reason })

const ledgerPath = "docs/debt.md"
const baselinePath = "docs/debt.baseline.json"

// Lint directives, matched only at the start of a comment so prose that mentions one is not counted.
const lintKinds = [
  ["eslint", /^eslint-disable(?:-next-line|-line)?(?=\s|$)/u],
  ["oxlint", /^oxlint-disable(?:-next-line|-line)?(?=\s|$)/u],
  ["ast-grep", /^ast-grep-ignore(?=\s|:|$)/u]
]

// TypeScript's own comment-directive rules (its scanner's commentDirectiveRegEx*): a `//` or `///`
// comment, or the last line of a block comment. A JSDoc continuation line (` * @ts-expect-error`) is
// not a directive, so it is not counted either.
const tsSingleLine = /^\/\/\/?\s*@(?:ts-expect-error|ts-ignore)/u
const tsLastLine = /^(?:\/|\*)*\s*@(?:ts-expect-error|ts-ignore)/u
const tsDirective = /@(?:ts-expect-error|ts-ignore)/u
const tsNoCheck = /^@ts-nocheck(?=\s|$)/u

// The Effect language service's own directive pattern. It reads the whole source text of a TypeScript
// file, so a directive inside a string literal is active too and is counted wherever it appears.
const effectDirective =
  /@effect-diagnostics(?:-next-line)?(?:\s(?:[a-zA-Z0-9/]+|\*):(?:off|warning|error|message|suggestion|skip-file))+/gmu

const scannedFile = /\.(?:[cm]?[jt]sx?)$/u
const typeScriptFile = /\.(?:[cm]?ts|tsx)$/u

/** Whether a tracked path belongs in the ledger: source and tests, never vendored, generated or built output. */
export const isLedgerSource = (file) =>
  scannedFile.test(file) &&
  !file.startsWith("repos/") &&
  !file.startsWith("tools/oxlint/anti-slop/") &&
  !file
    .split("/")
    .some(
      (segment) => segment === "generated" || segment === "dist" || segment === "node_modules" || segment === "vendor"
    )

/** The workspace package a path is counted under: `packages/<name>`, `scripts`, or `(root)`. */
export const packageOf = (file) => {
  const [first, second] = file.split("/")
  if (first === "packages" && second !== undefined) return second
  if (first === "scripts") return "scripts"
  return "(root)"
}

const commentBody = (raw) =>
  raw.startsWith("//")
    ? raw.replace(/^\/\/\/?/u, "").trim()
    : raw
        .slice(2, -2)
        .split("\n")
        .map((line) => line.replace(/^\s*\*?/u, "").trim())
        .filter((line) => line.length > 0)
        .join(" ")

const scriptKindOf = (file) =>
  file.endsWith(".tsx") || file.endsWith(".jsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS

// Every comment range in a file, found through the TypeScript parser so text inside string and
// template literals is never mistaken for a comment.
const commentRanges = (file, text) => {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file))
  const ranges = new Map()
  const collect = (found) => {
    for (const range of found ?? []) ranges.set(range.pos, range)
  }
  const visit = (node) => {
    collect(ts.getLeadingCommentRanges(text, node.pos))
    collect(ts.getTrailingCommentRanges(text, node.end))
    for (const child of node.getChildren(sourceFile)) visit(child)
  }
  visit(sourceFile)
  return [...ranges.values()].sort((left, right) => left.pos - right.pos)
}

const lintKindOf = (body) => lintKinds.find(([, pattern]) => pattern.test(body))?.[0]

// The line a TypeScript suppression lives on, when the comment is one TypeScript honours.
const typeScriptDirectiveLine = (raw) => {
  if (raw.startsWith("//")) return tsSingleLine.test(raw) ? raw : undefined
  const lastLine = raw.slice(raw.lastIndexOf("\n") + 1)
  return tsLastLine.test(lastLine) ? lastLine : undefined
}

const isDirectiveComment = (raw) =>
  typeScriptDirectiveLine(raw) !== undefined ||
  tsNoCheck.test(commentBody(raw)) ||
  lintKindOf(commentBody(raw)) !== undefined ||
  new RegExp(effectDirective.source, "u").test(raw)

const hasDashReason = (rest) => /(?:^|\s)--\s+\S/u.test(rest)

// A `//` comment on the line directly above that is not itself a directive counts as the reason.
const hasReasonAbove = (text, start) => {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1
  if (lineStart === 0) return false
  const previousStart = text.lastIndexOf("\n", lineStart - 2) + 1
  const previous = text.slice(previousStart, lineStart - 1).trim()
  if (!previous.startsWith("//")) return false
  return commentBody(previous).length > 0 && !isDirectiveComment(previous)
}

const directive = (file, kind, directiveText, reasoned) => ({
  file,
  package: packageOf(file),
  kind,
  text: directiveText.replace(/\s+/gu, " ").trim(),
  reasoned
})

const commentDirective = (file, text, range) => {
  const raw = text.slice(range.pos, range.end)
  const body = commentBody(raw)
  const reasonAbove = hasReasonAbove(text, range.pos)
  const typeScriptLine = typeScriptDirectiveLine(raw)
  if (typeScriptLine !== undefined || tsNoCheck.test(body)) {
    const line = typeScriptLine ?? body
    const rest = line
      .slice(line.search(/@ts-/u))
      .replace(/^@ts-(?:expect-error|ignore|nocheck)/u, "")
      .replace(/\*\/\s*$/u, "")
      .replace(/^:/u, "")
      .trim()
    return [directive(file, "typescript", tsDirective.test(line) ? body : line, rest.length > 0 || reasonAbove)]
  }
  const lintKind = lintKindOf(body)
  return lintKind === undefined ? [] : [directive(file, lintKind, body, hasDashReason(body) || reasonAbove)]
}

const effectDirectives = (file, text) =>
  [...text.matchAll(effectDirective)].map((match) => {
    const lineEnd = text.indexOf("\n", match.index)
    const rest = text.slice(match.index + match[0].length, lineEnd === -1 ? text.length : lineEnd)
    return directive(file, "effect-diagnostics", match[0], hasDashReason(rest) || hasReasonAbove(text, match.index))
  })

/**
 * Every escape directive in one file, recognised the way the tool that reads it does:
 * lint directives at the start of a comment, TypeScript suppressions by the compiler's comment rules,
 * and Effect diagnostics by the language service's pattern over the whole text of a TypeScript file.
 * `reasoned` is true when the directive explains itself (` -- reason`, free text after
 * `@ts-expect-error`, or a comment line directly above).
 *
 * Not counted: TypeScript or lint directives inside string and template literals. A test that writes a
 * throwaway source file (jcf-web's packed-consumer `verify.ts`) compiles it outside this repository's
 * checks, so its suppressions are fixture data rather than escapes from them.
 */
export const scanDirectives = (file, text) => [
  ...commentRanges(file, text).flatMap((range) => commentDirective(file, text, range)),
  ...(typeScriptFile.test(file) ? effectDirectives(file, text) : [])
]

const groupKey = ({ kind, package: name }) => `${name}\u0000${kind}`
const directiveKey = ({ file, text }) => `${file}\u0000${text}`

const countBy = (items, key) => {
  const counts = new Map()
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1)
  return counts
}

// Items of `left` beyond what `right` already holds, compared as multisets.
const surplus = (left, right, key) => {
  const remaining = countBy(right, key)
  return left.filter((item) => {
    const available = remaining.get(key(item)) ?? 0
    if (available === 0) return true
    remaining.set(key(item), available - 1)
    return false
  })
}

const sortDirectives = (directives) =>
  [...directives].sort(
    (left, right) =>
      left.package.localeCompare(right.package) ||
      left.kind.localeCompare(right.kind) ||
      left.file.localeCompare(right.file) ||
      left.text.localeCompare(right.text)
  )

/** The committed baseline for a set of directives. */
export const makeBaseline = (directives) => ({
  version: 1,
  directives: sortDirectives(directives).map(({ file, kind, package: name, reasoned, text }) => ({
    package: name,
    kind,
    file,
    text,
    reasoned
  }))
})

/**
 * Differences that fail the check. Counts ratchet per package and kind, so a removal in one package
 * cannot pay for an addition in another; a directive without a reason is accepted only if the
 * baseline already grandfathers that exact directive.
 */
export const compareToBaseline = (current, baseline) => {
  const currentCounts = countBy(current, groupKey)
  const baselineCounts = countBy(baseline.directives, groupKey)
  const failures = []
  for (const key of [...new Set([...currentCounts.keys(), ...baselineCounts.keys()])].sort()) {
    const [name, kind] = key.split("\u0000")
    const now = currentCounts.get(key) ?? 0
    const before = baselineCounts.get(key) ?? 0
    const inGroup = (directive) => groupKey(directive) === key
    if (now > before) {
      const added = surplus(current.filter(inGroup), baseline.directives.filter(inGroup), directiveKey)
      failures.push({ _tag: "CountRaised", package: name, kind, baseline: before, current: now, added })
    } else if (now < before) {
      failures.push({ _tag: "CountLowered", package: name, kind, baseline: before, current: now })
    }
  }
  const unreasoned = (directives) => directives.filter(({ reasoned }) => !reasoned)
  for (const directive of surplus(unreasoned(current), unreasoned(baseline.directives), directiveKey)) {
    failures.push({ _tag: "MissingReason", file: directive.file, kind: directive.kind, text: directive.text })
  }
  return failures
}

const escapeCell = (value) => value.replaceAll("|", "\\|")

/** The generated Markdown ledger. Files are listed without line numbers so moving code does not change it. */
export const renderLedger = (directives) => {
  const sorted = sortDirectives(directives)
  const kinds = [...new Set(sorted.map(({ kind }) => kind))].sort()
  const packages = [...new Set(sorted.map(({ package: name }) => name))].sort()
  const count = (predicate) => sorted.filter(predicate).length
  const lines = [
    "# Escape ledger",
    "",
    "Generated by `pnpm debt:update` from every lint, type and Effect-diagnostics escape directive in tracked source and tests.",
    "Counts ratchet per package and kind: `pnpm debt:check` fails when one rises, and a new directive needs a reason (` -- reason`, text after `@ts-expect-error`, or a comment line above).",
    "",
    `Total: **${sorted.length}** directives, **${count(({ reasoned }) => !reasoned)}** without a reason (grandfathered).`,
    "",
    `| Package | ${kinds.join(" | ")} | Total |`,
    `| --- | ${kinds.map(() => "---:").join(" | ")} | ---: |`,
    ...packages.map(
      (name) =>
        `| ${name} | ${kinds.map((kind) => count((item) => item.package === name && item.kind === kind)).join(" | ")} | ${count((item) => item.package === name)} |`
    ),
    ""
  ]
  for (const name of packages) {
    lines.push(`## ${name}`, "", "| File | Kind | Directive | Reason |", "| --- | --- | --- | --- |")
    for (const item of sorted.filter((directive) => directive.package === name)) {
      lines.push(
        `| [${item.file}](../${item.file}) | ${item.kind} | \`${escapeCell(item.text)}\` | ${item.reasoned ? "yes" : "**missing**"} |`
      )
    }
    lines.push("")
  }
  return lines.join("\n")
}

const describeFailure = (failure) => {
  switch (failure._tag) {
    case "CountRaised":
      return [
        `${failure.package}: ${failure.kind} escapes rose from ${failure.baseline} to ${failure.current}.`,
        ...failure.added.map(({ file, text }) => `    new: ${file}: ${text}`),
        "    Fix: remove the escape, or raise the baseline on purpose with `pnpm debt:update` in its own reviewed change."
      ].join("\n")
    case "CountLowered":
      return `${failure.package}: ${failure.kind} escapes fell from ${failure.baseline} to ${failure.current}. Fix: run \`pnpm debt:update\` to lock the lower count in.`
    case "MissingReason":
      return `${failure.file}: \`${failure.text}\` has no reason. Fix: add \` -- <reason>\` to the directive, or a comment line directly above it.`
  }
}

const BaselineFile = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    directives: Schema.Array(
      Schema.Struct({
        package: Schema.String,
        kind: Schema.String,
        file: Schema.String,
        text: Schema.String,
        reasoned: Schema.Boolean
      })
    )
  })
)

const trackedFiles = Effect.fn("DebtLedger.trackedFiles")(function* (repositoryRoot) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(ChildProcess.make("git", ["ls-files", "-z"], { cwd: repositoryRoot }))
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.decodeText(handle.stdout).pipe(Stream.mkString),
      Stream.decodeText(handle.stderr).pipe(Stream.mkString),
      handle.exitCode
    ],
    { concurrency: "unbounded" }
  )
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* fail(`git ls-files failed: ${stderr.trim()}`)
  }
  return stdout.split("\0").filter((file) => file.length > 0 && isLedgerSource(file))
})

const currentDirectives = Effect.fn("DebtLedger.currentDirectives")(function* (repositoryRoot) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files = yield* trackedFiles(repositoryRoot)
  const scanned = yield* Effect.forEach(
    files,
    (file) => fs.readFileString(path.join(repositoryRoot, file)).pipe(Effect.map((text) => scanDirectives(file, text))),
    { concurrency: 16 }
  )
  return scanned.flat()
})

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url))
  const repositoryRoot = path.dirname(path.dirname(scriptPath))
  const stdio = yield* Stdio.Stdio
  const update = (yield* stdio.args).includes("--update")
  const directives = yield* currentDirectives(repositoryRoot)
  const baselineFile = path.join(repositoryRoot, baselinePath)
  const ledgerFile = path.join(repositoryRoot, ledgerPath)
  const baseline = (yield* fs.exists(baselineFile))
    ? yield* Schema.decodeEffect(BaselineFile)(yield* fs.readFileString(baselineFile)).pipe(
        Effect.mapError((cause) => fail(`${baselinePath} is not a valid ledger baseline: ${cause.message}`))
      )
    : undefined
  const failures = baseline === undefined ? [] : compareToBaseline(directives, baseline)
  const nextBaseline = `${JSON.stringify(makeBaseline(directives), null, 2)}\n`
  const nextLedger = renderLedger(directives)

  if (update) {
    const missingReasons = failures.filter(({ _tag }) => _tag === "MissingReason")
    if (missingReasons.length > 0) {
      return yield* fail(
        `Refusing to grandfather new directives without a reason:\n- ${missingReasons.map(describeFailure).join("\n- ")}`
      )
    }
    yield* fs.writeFileString(baselineFile, nextBaseline)
    yield* fs.writeFileString(ledgerFile, nextLedger)
    for (const raised of failures.filter(({ _tag }) => _tag === "CountRaised")) {
      yield* Console.error(`Baseline raised on purpose: ${describeFailure(raised).split("\n")[0]}`)
    }
    yield* Console.log(`Escape ledger updated: ${directives.length} directives in ${ledgerPath}`)
    return
  }

  if (baseline === undefined) {
    return yield* fail(`${baselinePath} is missing. Fix: run \`pnpm debt:update\` and commit the baseline and ledger.`)
  }
  if (failures.length > 0) {
    return yield* fail(`Escape ledger check failed:\n- ${failures.map(describeFailure).join("\n- ")}`)
  }
  const committedLedger = (yield* fs.exists(ledgerFile)) ? yield* fs.readFileString(ledgerFile) : ""
  if (yield* fs.readFileString(baselineFile).pipe(Effect.map((committed) => committed !== nextBaseline))) {
    return yield* fail(`${baselinePath} is out of date with the source. Fix: run \`pnpm debt:update\`.`)
  }
  if (committedLedger !== nextLedger) {
    return yield* fail(`${ledgerPath} is out of date with the source. Fix: run \`pnpm debt:update\`.`)
  }
  yield* Console.log(`Escape ledger: ${directives.length} directives, every package at or below its baseline`)
})

// Report a ledger failure as its message alone (no stack), then exit non-zero.
const main = program.pipe(
  Effect.tapError((error) => (error._tag === "DebtLedgerError" ? Console.error(error.reason) : Console.error(error))),
  Effect.scoped,
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) NodeRuntime.runMain(main, { disableErrorReporting: true })
