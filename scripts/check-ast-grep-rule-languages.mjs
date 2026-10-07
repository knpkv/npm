import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { posix } from "node:path"
import { URL } from "node:url"
import { parse } from "yaml"

import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

class AstGrepRuleLanguageError extends Data.TaggedError("AstGrepRuleLanguageError") {
  get message() {
    return this.reason
  }
}

const fail = (reason) => new AstGrepRuleLanguageError({ reason })

// ast-grep's built-in extension mapping, for extensions sgconfig `languageGlobs` does not override.
const defaultLanguages = new Map([
  ["ts", "typescript"],
  ["cts", "typescript"],
  ["mts", "typescript"],
  ["tsx", "tsx"],
  ["js", "javascript"],
  ["cjs", "javascript"],
  ["mjs", "javascript"],
  ["jsx", "javascript"],
  ["css", "css"]
])

// `{a,b}` alternatives in a glob, expanded left to right.
const expandBraces = (glob) => {
  const match = glob.match(/\{([^{}]*)\}/u)
  if (match === null) return [glob]
  return match[1].split(",").flatMap((alternative) => expandBraces(glob.replace(match[0], alternative)))
}

/** The file extensions a `files` glob can match, or undefined when its last segment names none. */
export const extensionsOf = (glob) => {
  const extensions = expandBraces(glob).map(
    (expanded) =>
      expanded
        .split("/")
        .at(-1)
        ?.match(/\.([A-Za-z0-9]+)$/u)?.[1]
  )
  return extensions.every((extension) => extension !== undefined) ? [...new Set(extensions)] : undefined
}

/**
 * The languages ast-grep may parse a repository-relative path as: the `languageGlobs` entries whose globs match
 * the whole path, or else ast-grep's default for its extension. More than one means the config is ambiguous.
 */
export const languagesFor = (relativePath, languageGlobs) => {
  const overrides = Object.entries(languageGlobs ?? {})
    .filter(([, globs]) => globs.flatMap(expandBraces).some((glob) => posix.matchesGlob(relativePath, glob)))
    .map(([language]) => language)
  if (overrides.length > 0) return overrides
  const fallback = defaultLanguages.get(relativePath.match(/\.([A-Za-z0-9]+)$/u)?.[1] ?? "")
  return fallback === undefined ? [] : [fallback]
}

/**
 * Rule globs whose files ast-grep parses as a different language than the rule's, so the rule never runs on
 * them, plus globs whose language cannot be determined.
 */
export const languageFailures = (rule, languageGlobs) =>
  (rule.files ?? []).flatMap((glob) => {
    const extensions = extensionsOf(glob)
    if (extensions === undefined) return [{ _tag: "LanguageUndetermined", rule: rule.id, glob }]
    return expandBraces(glob).flatMap((variant) => {
      const path = samplePath(variant, rule.id, 0)
      const languages = languagesFor(path, languageGlobs)
      if (languages.length > 1) return [{ _tag: "LanguageAmbiguous", rule: rule.id, glob, path, languages }]
      return languages[0] === rule.language
        ? []
        : [{ _tag: "LanguageMismatch", rule: rule.id, ruleLanguage: rule.language, glob, path, language: languages[0] }]
    })
  })

/** A concrete repository-relative path that `glob` matches, unique to the rule and glob index. */
export const samplePath = (glob, ruleId, index) =>
  expandBraces(glob)[0]
    .replaceAll("**", "smoke")
    .replaceAll("*", `${ruleId}-${index}`)
    .replaceAll("?", "x")
    .replace(/\[[^\]]*\]/gu, (set) => set.replace(/^\[!?/u, "").charAt(0))

const extensionFor = (language, languageGlobs) =>
  [...defaultLanguages.keys()].find((extension) => {
    const languages = languagesFor(`smoke/sample.${extension}`, languageGlobs)
    return languages.length === 1 && languages[0] === language
  })

/** The fixture files to scan: one per `files` glob, holding the rule's first invalid fixture. */
export const smokeFiles = (rule, invalid, languageGlobs) => {
  const globs = rule.files ?? [`smoke/*.${extensionFor(rule.language, languageGlobs) ?? rule.language}`]
  return globs.map((glob, index) => ({ glob, path: samplePath(glob, rule.id, index), source: invalid }))
}

const describeFailure = (failure) => {
  switch (failure._tag) {
    case "LanguageMismatch":
      return `${failure.rule}: files glob ${failure.glob} selects files such as ${failure.path}, which sgconfig parses as ${failure.language ?? "no language"}, not ${failure.ruleLanguage}. The rule never runs on them. Fix: drop the glob or change the rule's language.`
    case "LanguageAmbiguous":
      return `${failure.rule}: files glob ${failure.glob} selects files such as ${failure.path}, which several sgconfig languageGlobs entries claim (${failure.languages.join(", ")}). Fix: make the languageGlobs entries disjoint.`
    case "LanguageUndetermined":
      return `${failure.rule}: files glob ${failure.glob} does not end in a file extension, so its language cannot be checked. Fix: name the extension.`
    case "MissingFixture":
      return `${failure.rule}: no invalid fixture in ast-grep/tests. Fix: add ${failure.rule}-test.yml with valid and invalid cases.`
    case "FixtureNotMatched":
      return `${failure.rule}: its first invalid fixture, written to ${failure.path} (from glob ${failure.glob}), produced no finding under the repository sgconfig. The rule does not fire on real files there.`
  }
}

const RuleDocument = Schema.Struct({
  id: Schema.String,
  language: Schema.String,
  files: Schema.optional(Schema.Array(Schema.String))
})
const TestDocument = Schema.Struct({ id: Schema.String, invalid: Schema.optional(Schema.Array(Schema.String)) })
const SgConfig = Schema.Struct({
  ruleDirs: Schema.Array(Schema.String),
  languageGlobs: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  testConfigs: Schema.optional(Schema.Array(Schema.Struct({ testDir: Schema.String })))
})
const Findings = Schema.fromJsonString(Schema.Array(Schema.Struct({ ruleId: Schema.String, file: Schema.String })))

const readYaml = Effect.fn("AstGrepRuleLanguages.readYaml")(function* (file, schema) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(file).pipe(Effect.mapError((cause) => fail(`${file}: ${cause.message}`)))
  const document = yield* Effect.try({ try: () => parse(text), catch: (cause) => fail(`${file}: ${String(cause)}`) })
  return yield* Schema.decodeUnknownEffect(schema)(document).pipe(
    Effect.mapError((cause) => fail(`${file} is not valid: ${cause.message}`))
  )
})

const yamlFiles = Effect.fn("AstGrepRuleLanguages.yamlFiles")(function* (directory) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries = yield* fs
    .readDirectory(directory)
    .pipe(Effect.mapError((cause) => fail(`${directory}: ${cause.message}`)))
  return entries
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .toSorted()
    .map((entry) => path.join(directory, entry))
})

// Scan `root` with ast-grep and return the findings; exit 1 only means findings were reported.
const scan = Effect.fn("AstGrepRuleLanguages.scan")(function* (astGrep, root) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(ChildProcess.make(astGrep, ["scan", "--json=compact"], { cwd: root }))
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.decodeText(handle.stdout).pipe(Stream.mkString),
      Stream.decodeText(handle.stderr).pipe(Stream.mkString),
      handle.exitCode
    ],
    { concurrency: "unbounded" }
  )
  if (exitCode !== ChildProcessSpawner.ExitCode(0) && exitCode !== ChildProcessSpawner.ExitCode(1)) {
    return yield* fail(`ast-grep scan exited with ${exitCode}:\n${stderr.trim()}`)
  }
  return yield* Schema.decodeEffect(Findings)(stdout).pipe(
    Effect.mapError((cause) => fail(`ast-grep scan output is not valid JSON findings: ${cause.message}`))
  )
})

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const repositoryRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const sgconfigPath = path.join(repositoryRoot, "sgconfig.yml")
  const sgconfig = yield* readYaml(sgconfigPath, SgConfig)

  const rules = []
  for (const ruleDir of sgconfig.ruleDirs) {
    for (const file of yield* yamlFiles(path.join(repositoryRoot, ruleDir))) {
      rules.push({ ...(yield* readYaml(file, RuleDocument)), source: file })
    }
  }
  const firstInvalid = new Map()
  for (const { testDir } of sgconfig.testConfigs ?? []) {
    for (const file of yield* yamlFiles(path.join(repositoryRoot, testDir))) {
      const test = yield* readYaml(file, TestDocument)
      const invalid = test.invalid?.[0]
      if (invalid !== undefined && !firstInvalid.has(test.id)) firstInvalid.set(test.id, invalid)
    }
  }

  const failures = rules.flatMap((rule) => [
    ...languageFailures(rule, sgconfig.languageGlobs),
    ...(firstInvalid.has(rule.id) ? [] : [{ _tag: "MissingFixture", rule: rule.id }])
  ])

  // Smoke: copy the real sgconfig and rules into a scratch tree, write each rule's first invalid fixture
  // at a path every one of its `files` globs selects, and require a finding from that rule in each file.
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "ast-grep-rule-languages-" })
  yield* fs.copyFile(sgconfigPath, path.join(root, "sgconfig.yml"))
  for (const ruleDir of sgconfig.ruleDirs) {
    yield* fs.copy(path.join(repositoryRoot, ruleDir), path.join(root, ruleDir))
  }
  const expected = rules.flatMap((rule) => {
    const invalid = firstInvalid.get(rule.id)
    return invalid === undefined
      ? []
      : smokeFiles(rule, invalid, sgconfig.languageGlobs).map((file) => ({ ...file, rule: rule.id }))
  })
  for (const file of expected) {
    yield* fs.makeDirectory(path.dirname(path.join(root, file.path)), { recursive: true })
    yield* fs.writeFileString(path.join(root, file.path), file.source)
  }
  const findings = yield* scan(path.join(repositoryRoot, "node_modules", ".bin", "ast-grep"), root)
  const found = new Set(findings.map(({ file, ruleId }) => `${ruleId}\0${path.normalize(file)}`))
  for (const file of expected) {
    if (!found.has(`${file.rule}\0${path.normalize(file.path)}`)) {
      failures.push({ _tag: "FixtureNotMatched", rule: file.rule, path: file.path, glob: file.glob })
    }
  }

  if (failures.length > 0) {
    return yield* fail(`ast-grep rule languages failed:\n- ${failures.map(describeFailure).join("\n- ")}`)
  }
  yield* Console.log(
    `ast-grep rule languages: ${rules.length} rules match their sgconfig language and fire on ${expected.length} fixture paths`
  )
}).pipe(Effect.mapError((cause) => (cause._tag === "AstGrepRuleLanguageError" ? cause : fail(String(cause)))))

// Report a failure as its message alone (no stack), then exit non-zero.
const main = program.pipe(
  Effect.tapError((error) => Console.error(error.reason)),
  Effect.scoped,
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) NodeRuntime.runMain(main, { disableErrorReporting: true })
