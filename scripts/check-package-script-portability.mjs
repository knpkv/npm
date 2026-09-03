import assert from "node:assert/strict"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { parse } from "yaml"

const environmentAssignment = /^\s*[A-Za-z_][A-Za-z0-9_]*=/u
const buildLifecycleNames = new Set(["build", "prebuild", "postbuild"])
const ignoredWorkspaceSegments = new Set(["generated", "node_modules", "vendor"])
const safeWorkspaceSegment = /^[A-Za-z0-9._-]+$/u
const isBuildScript = (name) => name.split(":").some((segment) => buildLifecycleNames.has(segment))
const browserPairingBuild = /^pnpm\s+--filter\s+"?@knpkv\/browser-pairing"?\s+build\s*$/u
const codeCommitWebRoleCheck = /^tsc\s+-p\s+tsconfig\.roles\.json\s+--noEmit$/u
const codeCommitWebLifecycleRequirements = [
  {
    script: "predev",
    description: "a browser-pairing build",
    matches: (command) => hasExecutableLifecycleCommand(command, browserPairingBuild)
  },
  {
    script: "prestart",
    description: "a browser-pairing build",
    matches: (command) => hasExecutableLifecycleCommand(command, browserPairingBuild)
  },
  {
    script: "pretest",
    description: "a browser-pairing build",
    matches: (command) => hasExecutableLifecycleCommand(command, browserPairingBuild)
  },
  {
    script: "test:browser",
    description: "a browser-pairing build",
    matches: (command) => hasExecutableLifecycleCommand(command, browserPairingBuild)
  },
  {
    script: "check",
    description: "the role-aware tsc check",
    matches: (command) => hasExecutableLifecycleCommand(command, codeCommitWebRoleCheck)
  }
]
const codeCommitLifecycleRequirements = ["prestart", "prestart:web"].map((script) => ({
  script,
  description: "a browser-pairing build",
  matches: (command) => hasExecutableLifecycleCommand(command, browserPairingBuild)
}))

const hasDirectEnvironmentAssignment = (command) => {
  let quote
  let escaped = false
  const boundaries = [0]
  for (let index = 0; index < command.length; index++) {
    const character = command[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === ";" || character === "\n" || character === "|" || character === "(") {
      boundaries.push(index + 1)
    }
    if (
      character === "{" &&
      /\s/u.test(command[index + 1] ?? "") &&
      boundaries.some((boundary) => command.slice(boundary, index).trim() === "")
    ) {
      boundaries.push(index + 1)
    }
    if (character === "&") boundaries.push(index + (command[index + 1] === "&" ? 2 : 1))
  }
  return boundaries.some((index) => environmentAssignment.test(command.slice(index)))
}

const hereDocumentDelimiters = (line) => {
  const delimiters = []
  let quote
  let escaped = false
  for (let index = 0; index < line.length - 1; index++) {
    const character = line[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (
      character === "#" &&
      (index === 0 || /\s/u.test(line[index - 1] ?? "") || ";|&(){}".includes(line[index - 1] ?? ""))
    ) {
      break
    }
    if (character !== "<" || line[index + 1] !== "<" || line[index + 2] === "<") continue
    let delimiterIndex = index + 2
    const stripTabs = line[delimiterIndex] === "-"
    if (stripTabs) delimiterIndex++
    while (/\s/u.test(line[delimiterIndex] ?? "")) delimiterIndex++
    const delimiterQuote = line[delimiterIndex]
    if (delimiterQuote === "'" || delimiterQuote === '"') {
      const end = line.indexOf(delimiterQuote, delimiterIndex + 1)
      if (end === -1) return undefined
      const delimiter = line.slice(delimiterIndex + 1, end)
      if (delimiter.length === 0) return undefined
      delimiters.push({ delimiter, stripTabs, expandable: false })
      index = end
      continue
    }
    const end = line.slice(delimiterIndex).search(/[\s;|&(){}]/u)
    const delimiter = line.slice(delimiterIndex, end === -1 ? line.length : delimiterIndex + end)
    if (!/^[A-Za-z0-9_.-]+$/u.test(delimiter)) return undefined
    delimiters.push({ delimiter, stripTabs, expandable: true })
    index = delimiterIndex + delimiter.length - 1
  }
  return delimiters
}

const removeHereDocumentBodies = (command) => {
  const lines = command.split("\n")
  const retained = []
  const pending = []
  for (const line of lines) {
    const active = pending[0]
    if (active !== undefined) {
      const candidate = active.stripTabs ? line.replace(/^\t+/u, "") : line
      if (active.expandable && active.continued) {
        active.continued = hasUnescapedTrailingBackslash(candidate)
        continue
      }
      if (candidate === active.delimiter) {
        pending.shift()
        continue
      }
      active.continued = active.expandable && hasUnescapedTrailingBackslash(candidate)
      continue
    }
    retained.push(line)
    const delimiters = hereDocumentDelimiters(line)
    if (delimiters === undefined) return ""
    pending.push(...delimiters)
  }
  return retained.join("\n")
}

const hasUnescapedTrailingBackslash = (line) => {
  const trailing = line.match(/(\\+)$/u)?.[1]
  return trailing !== undefined && trailing.length % 2 === 1
}

const removeShellComments = (command) => {
  let quote
  let escaped = false
  let result = ""
  for (let index = 0; index < command.length; index++) {
    const character = command[index]
    if (escaped) {
      escaped = false
      result += character
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      result += character
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      result += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      result += character
      continue
    }
    const previous = command[index - 1]
    if (character === "#" && (previous === undefined || /\s/u.test(previous) || ";|&(){}".includes(previous))) {
      while (index < command.length && command[index] !== "\n") {
        result += " "
        index++
      }
      if (index < command.length) result += "\n"
      continue
    }
    result += character
  }
  return result
}

const shellCommandSegments = (command, sanitized = false) => {
  const source = sanitized ? command : removeShellComments(removeHereDocumentBodies(command))
  const segments = []
  let segmentStart = 0
  let segmentOperator
  let quote
  let escaped = false
  let groupDepth = 0
  const pushSegment = (index, operator, width = 1) => {
    segments.push({
      text: source.slice(segmentStart, index),
      operator: segmentOperator,
      nextOperator: operator,
      start: segmentStart,
      end: index
    })
    segmentStart = index + width
    segmentOperator = operator
  }
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === "(" || character === "{") {
      groupDepth++
      continue
    }
    if ((character === ")" || character === "}") && groupDepth > 0) {
      groupDepth--
      continue
    }
    if (groupDepth > 0) continue
    if (character === ";" || character === "\n" || character === "|" || character === "&") {
      const doubled = (character === "|" || character === "&") && source[index + 1] === character
      pushSegment(index, doubled ? character + character : character, doubled ? 2 : 1)
      if (doubled) index++
      continue
    }
  }
  if (segmentStart <= source.length) {
    segments.push({
      text: source.slice(segmentStart),
      operator: segmentOperator,
      start: segmentStart,
      end: source.length
    })
  }
  return segments
}

const functionDefinitionPattern = /(?:^|[;\n]|&&|\|\||[|&({])\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{/gu

const matchingBrace = (source, openIndex, opener, closer) => {
  let depth = 0
  let quote
  let escaped = false
  for (let index = openIndex; index < source.length; index++) {
    const character = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === opener) depth++
    if (character === closer && --depth === 0) return index
  }
  return undefined
}

const extractFunctionDefinitions = (command) => {
  const source = removeShellComments(removeHereDocumentBodies(command))
  const definitions = []
  functionDefinitionPattern.lastIndex = 0
  for (const match of source.matchAll(functionDefinitionPattern)) {
    const name = match[1]
    const openIndex = match.index + match[0].length - 1
    const closeIndex = matchingBrace(source, openIndex, "{", "}")
    if (closeIndex === undefined) continue
    const nameIndex = source.indexOf(name, match.index)
    definitions.push({
      name,
      start: nameIndex,
      end: closeIndex + 1,
      body: source.slice(openIndex + 1, closeIndex),
      grouped: ["{", "("].includes(match[0][0] ?? "")
    })
    functionDefinitionPattern.lastIndex = closeIndex + 1
  }
  let withoutDefinitions = source
  for (const definition of definitions.toReversed()) {
    withoutDefinitions = `${withoutDefinitions.slice(0, definition.start)}${" ".repeat(definition.end - definition.start)}${withoutDefinitions.slice(definition.end)}`
  }
  return { definitions, source: withoutDefinitions }
}

const firstShellWord = (text) => text.trim().match(/^\\?([A-Za-z_][A-Za-z0-9_]*)(?:\s|$)/u)?.[1]

const hasActiveFunctionDefinition = (text, start, definitions) => {
  const commandName = firstShellWord(text)
  return commandName !== undefined && definitions.some(({ name, end }) => name === commandName && end <= start)
}

const segmentReachability = (segments, definitions = []) => {
  const reachability = []
  let previousResult = "unknown"
  let terminated = false
  for (const [index, segment] of segments.entries()) {
    const reachable =
      !terminated &&
      (index === 0 ||
        (segment.operator === "&&" && previousResult === "success") ||
        (segment.operator === "||" && previousResult === "failure") ||
        (segment.operator !== "&&" && segment.operator !== "||"))
    reachability.push(reachable)
    const text = segment.text.trim()
    if (reachable) {
      previousResult =
        text === "true"
          ? "success"
          : text === "false"
            ? "failure"
            : isKnownSuccessfulShellCommand(text, segment.start, definitions)
              ? "success"
              : "unknown"
      if (/^(?:exec|exit|return)(?:\s|$)/u.test(text)) terminated = true
    }
  }
  return reachability
}

// A command whose failure already fails the lifecycle may continue on its success path.
const isKnownSuccessfulShellCommand = (text, start, definitions) =>
  !hasActiveFunctionDefinition(text, start, definitions) &&
  (/^(?:printf|echo|:)(?:\s|$)/u.test(text.trim()) ||
    browserPairingBuild.test(text.trim()) ||
    codeCommitWebRoleCheck.test(text.trim()) ||
    /^tsc\s+-b(?:\s|$)/u.test(text.trim()))

const unsupportedShellWords = new Set([
  "case",
  "command",
  "do",
  "done",
  "esac",
  "eval",
  "fi",
  "for",
  "if",
  "select",
  "source",
  "then",
  "trap",
  "until",
  "while"
])

const hasUnsupportedShellControl = (source) => {
  const segments = shellCommandSegments(source, true)
  return (
    segments.some(({ text }) => unsupportedShellWords.has(firstShellWord(text) ?? "")) ||
    segments.some(({ text }) => /^\\?(?:\.|source)(?:\s|$)/u.test(text.trim())) ||
    segments.some(({ text }) => text.trim().startsWith("!")) ||
    segments.some(({ nextOperator }) => nextOperator === "&")
  )
}

const hasUnsafeInvokedFunction = (command, visited = new Set()) => {
  const { definitions, source } = extractFunctionDefinitions(command)
  if (hasUnsupportedShellControl(source)) return true
  const segments = shellCommandSegments(source, true)
  const reachability = segmentReachability(segments, definitions)
  return definitions.some((definition) => {
    if (visited.has(definition.name)) return false
    const invoked = segments.some(({ text, start }, index) => {
      if (!reachability[index] || firstShellWord(text) !== definition.name) return false
      const activeDefinition = definitions
        .filter((candidate) => candidate.name === definition.name && candidate.end <= start)
        .at(-1)
      return activeDefinition === definition
    })
    return (
      (definition.grouped || invoked) &&
      (hasShellTermination(definition.body) ||
        hasUnsafeInvokedFunction(definition.body, new Set([...visited, definition.name])))
    )
  })
}

const groupedCommandBody = (text) => {
  const trimmed = text.trim()
  const opener = trimmed[0]
  const closer = opener === "{" ? "}" : opener === "(" ? ")" : undefined
  if (closer === undefined || trimmed.at(-1) !== closer) return undefined
  const closeIndex = matchingBrace(trimmed, 0, opener, closer)
  return closeIndex === trimmed.length - 1 ? trimmed.slice(1, -1) : undefined
}

const hasShellTermination = (command) => {
  const { definitions, source } = extractFunctionDefinitions(command)
  const segments = shellCommandSegments(source, true)
  const reachability = segmentReachability(segments, definitions)
  return segments.some(({ text }, index) => {
    if (!reachability[index]) return false
    const trimmed = text.trim()
    if (/^(?:exec|exit)(?:\s|$)/u.test(trimmed)) return true
    const body = groupedCommandBody(trimmed)
    return body !== undefined && hasShellTermination(body)
  })
}

const hasStatusRecoveryOperator = (command) => {
  const segments = shellCommandSegments(command, true)
  return segments.some(({ text, nextOperator }) => {
    if (nextOperator === "||") return true
    const body = groupedCommandBody(text)
    return body !== undefined && hasStatusRecoveryOperator(body)
  })
}

const hasStatusReplacement = (segments, index) =>
  segments.slice(index + 1).some(({ operator, text }) => (operator === ";" || operator === "\n") && text.trim() !== "")

const hasStatusSafeContinuation = (segments, index, nextOperator) =>
  nextOperator === undefined ||
  (nextOperator === "&&" &&
    !hasStatusReplacement(segments, index) &&
    !segments.slice(index).some(({ text, nextOperator: followingOperator }) => {
      if (followingOperator === "||") return true
      const body = groupedCommandBody(text)
      return body !== undefined && hasStatusRecoveryOperator(body)
    })) ||
  (nextOperator === ";" && segments.slice(index + 1).every(({ text }) => text.trim() === ""))

const hasExecutableLifecycleCommand = (command, matcher, visited = new Set()) => {
  const { definitions, source } = extractFunctionDefinitions(command)
  if (hasUnsupportedShellControl(source) || hasUnsafeInvokedFunction(command, visited)) return false
  const segments = shellCommandSegments(source, true)
  const reachability = segmentReachability(segments, definitions)
  if (
    segments.some(({ text, nextOperator, start }, index) => {
      if (!reachability[index] || !hasStatusSafeContinuation(segments, index, nextOperator)) {
        return false
      }
      if (!hasActiveFunctionDefinition(text, start, definitions) && matcher.test(text.trim())) return true
      const body = groupedCommandBody(text)
      return body !== undefined && hasExecutableLifecycleCommand(body, matcher, visited)
    })
  ) {
    return true
  }
  return definitions.some((definition) => {
    if (visited.has(definition.name)) return false
    const invoked = segments.some(({ text, nextOperator, start }, index) => {
      if (
        !reachability[index] ||
        !hasStatusSafeContinuation(segments, index, nextOperator) ||
        firstShellWord(text) !== definition.name
      ) {
        return false
      }
      const activeDefinition = definitions
        .filter((candidate) => candidate.name === definition.name && candidate.end <= start)
        .at(-1)
      return activeDefinition === definition
    })
    return invoked && hasExecutableLifecycleCommand(definition.body, matcher, new Set([...visited, definition.name]))
  })
}

class PackageScriptPortabilityError extends Data.TaggedError("PackageScriptPortabilityError") {
  get message() {
    return this.reason
  }
}

const PackageManifest = Schema.fromJsonString(
  Schema.Struct({
    scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String))
  })
)
const WorkspaceConfig = Schema.Struct({ packages: Schema.Array(Schema.String) })

const classifyWorkspacePattern = (pattern) => {
  const segments = pattern.split("/")
  if (
    pattern.startsWith("!") ||
    segments.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return undefined
  }
  const wildcard = segments.at(-1) === "*"
  const directories = wildcard ? segments.slice(0, -1) : segments
  if (directories.length === 0 || directories.some((segment) => !safeWorkspaceSegment.test(segment))) {
    return undefined
  }
  return { directories, wildcard }
}

export const findNonPortableBuildScripts = (manifestPath, scripts) =>
  Object.entries(scripts ?? {})
    .filter(
      ([name, command]) => isBuildScript(name) && Predicate.isString(command) && hasDirectEnvironmentAssignment(command)
    )
    .map(([name]) => `${manifestPath}: scripts.${name} uses a POSIX-only environment assignment`)

export const findCodeCommitWebLifecycleGaps = (manifestPath, scripts, dependencies, devDependencies) => {
  if (manifestPath === "packages/codecommit/package.json") {
    return codeCommitLifecycleRequirements
      .filter(({ script, matches }) => !matches(scripts?.[script] ?? ""))
      .map(({ script, description }) => `${manifestPath}: scripts.${script} must include ${description}`)
  }
  if (
    manifestPath !== "packages/codecommit-web/package.json" ||
    !("@knpkv/browser-pairing" in { ...dependencies, ...devDependencies })
  ) {
    return []
  }
  return codeCommitWebLifecycleRequirements
    .filter(({ script, matches }) => !matches(scripts?.[script] ?? ""))
    .map(({ script, description }) => `${manifestPath}: scripts.${script} must include ${description}`)
}

assert.deepEqual(
  findNonPortableBuildScripts("scripts/package.json", {
    postbuild: "OUTPUT=dist publish",
    prebuild: "CACHE=warm prepare",
    "storybook:build": "NODE_OPTIONS=--disable-warning=DEP0205 storybook build"
  }),
  [
    "scripts/package.json: scripts.postbuild uses a POSIX-only environment assignment",
    "scripts/package.json: scripts.prebuild uses a POSIX-only environment assignment",
    "scripts/package.json: scripts.storybook:build uses a POSIX-only environment assignment"
  ]
)
assert.equal(hasDirectEnvironmentAssignment("prepare | FOO=1 tool"), true)
assert.equal(hasDirectEnvironmentAssignment("prepare\nFOO=1 tool"), true)
assert.equal(hasDirectEnvironmentAssignment("prepare | cross-env FOO=1 tool"), false)
assert.equal(hasDirectEnvironmentAssignment("printf 'prepare | FOO=1 tool'"), false)
assert.equal(hasDirectEnvironmentAssignment("prepare & FOO=1 tool"), true)
assert.equal(hasDirectEnvironmentAssignment("prepare & cross-env FOO=1 tool"), false)
assert.equal(hasDirectEnvironmentAssignment("printf 'prepare & FOO=1 tool'"), false)
assert.equal(hasDirectEnvironmentAssignment("(FOO=1 tool)"), true)
assert.equal(hasDirectEnvironmentAssignment("(cross-env FOO=1 tool)"), false)
assert.equal(hasDirectEnvironmentAssignment("{ FOO=1 tool; }"), true)
assert.equal(hasDirectEnvironmentAssignment("tool {FOO=1}"), false)
assert.equal(hasDirectEnvironmentAssignment("tool { FOO=1 }"), false)
assert.equal(hasDirectEnvironmentAssignment("'(FOO=1 tool)'"), false)
assert.equal(hasDirectEnvironmentAssignment("\\(FOO=1 tool\\)"), false)
assert.deepEqual(
  findNonPortableBuildScripts("scratchpad/package.json", {
    "storybook:build": "tsx scripts/build-storybook.ts"
  }),
  []
)
assert.deepEqual(classifyWorkspacePattern("packages/*"), { directories: ["packages"], wildcard: true })
assert.deepEqual(classifyWorkspacePattern("scripts"), { directories: ["scripts"], wildcard: false })
assert.equal(classifyWorkspacePattern("!packages/legacy"), undefined)
assert.equal(classifyWorkspacePattern("packages/**"), undefined)
const codeCommitWebScripts = {
  predev: "pnpm --filter @knpkv/browser-pairing build",
  prestart: "pnpm --filter @knpkv/browser-pairing build",
  pretest: "pnpm --filter @knpkv/browser-pairing build",
  "test:browser": 'pnpm --filter "@knpkv/browser-pairing" build',
  check: "tsc -b tsconfig.json && tsc -p tsconfig.roles.json --noEmit"
}
const browserPairingDependency = { "@knpkv/browser-pairing": "workspace:^" }
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    codeCommitWebScripts,
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: 'echo "pnpm --filter @knpkv/browser-pairing build"',
      check: 'echo "tsc -p tsconfig.roles.json --noEmit"'
    },
    browserPairingDependency
  ),
  [
    "packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build",
    "packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"
  ]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: 'printf "pnpm --filter @knpkv/browser-pairing build"; pnpm --filter @knpkv/browser-pairing build',
      check: 'printf "tsc -p tsconfig.roles.json --noEmit" && tsc -p tsconfig.roles.json --noEmit'
    },
    browserPairingDependency
  ),
  []
)
for (const requirement of codeCommitWebLifecycleRequirements) {
  const invalidCommand =
    requirement.script === "check"
      ? "tsc -p tsconfig.roles.json --noEmit-extra"
      : "pnpm --filter @knpkv/browser-pairing build:docs"
  const invalidScripts = { ...codeCommitWebScripts, [requirement.script]: invalidCommand }
  assert.deepEqual(
    findCodeCommitWebLifecycleGaps("packages/codecommit-web/package.json", invalidScripts, browserPairingDependency),
    [`packages/codecommit-web/package.json: scripts.${requirement.script} must include ${requirement.description}`]
  )
}
for (const invalidRoleCheck of [
  "tsc -p tsconfig.roles.json --noEmit --help",
  "tsc -p tsconfig.roles.json --noEmit --showConfig"
]) {
  assert.deepEqual(
    findCodeCommitWebLifecycleGaps(
      "packages/codecommit-web/package.json",
      { ...codeCommitWebScripts, check: invalidRoleCheck },
      browserPairingDependency
    ),
    ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
  )
}
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, prestart: "pnpm --filter @knpkv/browser-pairing build:docs" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.prestart must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "true || pnpm --filter @knpkv/browser-pairing build; vite" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "pnpm --filter @knpkv/browser-pairing build & vite" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "pnpm --filter @knpkv/browser-pairing build && vite" },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "pnpm --filter @knpkv/browser-pairing build --help" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "pnpm --filter @knpkv/browser-pairing build || true" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "test -f absent && pnpm --filter @knpkv/browser-pairing build; true" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "test -f present && pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: "test -f present && tsc -p tsconfig.roles.json --noEmit" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "pnpm --filter @knpkv/browser-pairing build | cat" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "! true && pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: "! true && tsc -p tsconfig.roles.json --noEmit" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: "setup() { cleanup() { trap 'exit 0' 0; }; true; }; setup; pnpm --filter @knpkv/browser-pairing build"
    },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "pnpm --filter @knpkv/browser-pairing build && false || true" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "pnpm() { true; }; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: "tsc() { true; }; tsc -p tsconfig.roles.json --noEmit" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "true && pnpm() { true; }; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: "true || tsc() { true; }; tsc -p tsconfig.roles.json --noEmit" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "build_pairing() { true; }; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: "true && build_pairing() { true; }; pnpm --filter @knpkv/browser-pairing build"
    },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "trap 'exit 0' 0; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: "trap 'exit 0' 0; tsc -p tsconfig.roles.json --noEmit" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: "cleanup() { trap 'exit 0' 0; }; cleanup; pnpm --filter @knpkv/browser-pairing build"
    },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: "cleanup() { trap 'exit 0' 0; }; cleanup; tsc -p tsconfig.roles.json --noEmit" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: "setup() { cleanup() { trap 'exit 0' 0; }; cleanup; }; setup; pnpm --filter @knpkv/browser-pairing build"
    },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      check: "setup() { cleanup() { trap 'exit 0' 0; }; cleanup; }; setup; tsc -p tsconfig.roles.json --noEmit"
    },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "pnpm --filter @knpkv/browser-pairing build && vite" },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: "setup() { prepare() { true; }; prepare; }; setup; pnpm --filter @knpkv/browser-pairing build && vite"
    },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: "{ cleanup() { trap 'exit 0' 0; }; cleanup; }; pnpm --filter @knpkv/browser-pairing build"
    },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      check: "(cleanup() { trap 'exit 0' 0; }; cleanup); tsc -p tsconfig.roles.json --noEmit"
    },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: "{ prepare() { true; }; prepare; }; pnpm --filter @knpkv/browser-pairing build && vite"
    },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "exit 0; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "exec true; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "pnpm --filter @knpkv/browser-pairing build; exit 0" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: "build_pairing() { return 0; pnpm --filter @knpkv/browser-pairing build; }; build_pairing"
    },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "false && { pnpm --filter @knpkv/browser-pairing build; }; vite" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "true || (pnpm --filter @knpkv/browser-pairing build); vite" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "{ pnpm --filter @knpkv/browser-pairing build; } && vite" },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "pnpm --filter @knpkv/browser-pairing build && vite; true" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "pnpm --filter @knpkv/browser-pairing build && vite\ntrue" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: "tsc -p tsconfig.roles.json --noEmit && vite\ntrue" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "echo() { false; }; echo ready && pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: "printf() { false; }; printf ready && tsc -p tsconfig.roles.json --noEmit" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "stop() { exec true; }; stop; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: "stop() { exit 0; }; stop; tsc -p tsconfig.roles.json --noEmit" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "stop() { exec true; }; eval stop; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: "stop() { exit 0; }; eval stop; tsc -p tsconfig.roles.json --noEmit" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: "stop() { exit 0; }; command eval stop; pnpm --filter @knpkv/browser-pairing build"
    },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: "stop() { exit 0; }; command eval stop; tsc -p tsconfig.roles.json --noEmit" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: ". ./stop.sh; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: "source ./stop.sh; tsc -p tsconfig.roles.json --noEmit" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "stop() { exit 0; }; \\eval stop; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: "\\. ./stop.sh; tsc -p tsconfig.roles.json --noEmit" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: "tsc -p tsconfig.roles.json --noEmit && vite; true" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "pnpm --filter @knpkv/browser-pairing build && echo complete &" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "build_pairing() { pnpm --filter @knpkv/browser-pairing build; }; vite" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: "build_pairing() { pnpm --filter @knpkv/browser-pairing build; }; build_pairing; vite"
    },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: "build_pairing; build_pairing() { pnpm --filter @knpkv/browser-pairing build; }; vite"
    },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "cat <<'EOF'\npnpm --filter @knpkv/browser-pairing build\nEOF\nvite" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "cat <<'EOF'\nbody\nEOF\npnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: "cat <<EOF\npayload\\\nEOF\npnpm --filter @knpkv/browser-pairing build\nEOF\nvite"
    },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "echo ready # ; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "echo ready;# ; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "echo ready;# <<EOF\npnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "false && pnpm --filter @knpkv/browser-pairing build; vite" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "if false; then\npnpm --filter @knpkv/browser-pairing build\nfi" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "echo '#' ; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  []
)
const codeCommitScripts = {
  start: "bun src/bin.ts",
  "start:web": "bun src/bin.ts web",
  prestart: "pnpm --filter @knpkv/browser-pairing build",
  "prestart:web": "pnpm --filter @knpkv/browser-pairing build"
}
assert.deepEqual(findCodeCommitWebLifecycleGaps("packages/codecommit/package.json", codeCommitScripts, {}), [])
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit/package.json",
    { ...codeCommitScripts, prestart: "bun src/bin.ts" },
    {}
  ),
  ["packages/codecommit/package.json: scripts.prestart must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit/package.json",
    { ...codeCommitScripts, "prestart:web": "bun src/bin.ts web" },
    {}
  ),
  ["packages/codecommit/package.json: scripts.prestart:web must include a browser-pairing build"]
)
assert.deepEqual(findCodeCommitWebLifecycleGaps("packages/other/package.json", {}, browserPairingDependency), [])

const workspaceManifestPaths = Effect.fn("PackageScriptPortability.workspaceManifestPaths")(
  function* (fileSystem, path, repositoryRoot, patterns) {
    const manifests = [path.join(repositoryRoot, "package.json")]
    for (const pattern of patterns) {
      const classified = classifyWorkspacePattern(pattern)
      if (classified === undefined) {
        return yield* Effect.fail(
          new PackageScriptPortabilityError({
            reason: `pnpm-workspace.yaml: unsupported workspace pattern ${JSON.stringify(pattern)}`
          })
        )
      }
      if (classified.directories.some((segment) => ignoredWorkspaceSegments.has(segment))) continue
      const directory = path.join(repositoryRoot, ...classified.directories)
      if (!classified.wildcard) {
        manifests.push(path.join(directory, "package.json"))
        continue
      }
      for (const entry of (yield* fileSystem.readDirectory(directory)).toSorted()) {
        if (ignoredWorkspaceSegments.has(entry)) continue
        const child = path.join(directory, entry)
        if ((yield* fileSystem.stat(child)).type === "Directory") manifests.push(path.join(child, "package.json"))
      }
    }
    return [...new Set(manifests)].toSorted()
  }
)

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url))
  const repositoryRoot = path.dirname(path.dirname(scriptPath))
  const workspacePath = path.join(repositoryRoot, "pnpm-workspace.yaml")
  const workspaceSource = yield* fileSystem.readFileString(workspacePath)
  const workspace = yield* Effect.try({
    try: () => parse(workspaceSource),
    catch: (cause) => new PackageScriptPortabilityError({ cause, reason: "pnpm-workspace.yaml: invalid YAML" })
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(WorkspaceConfig)),
    Effect.mapError(
      (cause) => new PackageScriptPortabilityError({ cause, reason: "pnpm-workspace.yaml: invalid workspace list" })
    )
  )
  const manifestPaths = yield* workspaceManifestPaths(fileSystem, path, repositoryRoot, workspace.packages)

  const diagnostics = []
  let checked = 0
  for (const manifestPath of manifestPaths) {
    if (!(yield* fileSystem.exists(manifestPath))) continue
    const location = path.relative(repositoryRoot, manifestPath)
    const manifest = yield* Schema.decodeUnknownEffect(PackageManifest)(
      yield* fileSystem.readFileString(manifestPath)
    ).pipe(
      Effect.mapError(
        (cause) => new PackageScriptPortabilityError({ cause, reason: `${location}: invalid package manifest` })
      )
    )
    diagnostics.push(
      ...findNonPortableBuildScripts(location, manifest.scripts),
      ...findCodeCommitWebLifecycleGaps(location, manifest.scripts, manifest.dependencies, manifest.devDependencies)
    )
    checked += 1
  }

  if (diagnostics.length > 0) {
    return yield* Effect.fail(new PackageScriptPortabilityError({ reason: diagnostics.join("\n") }))
  }
  yield* Console.log(`Package-script portability checked ${checked} manifests`)
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
