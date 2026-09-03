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
const protectedExecutableName = (matcher) =>
  matcher === browserPairingBuild ? "pnpm" : matcher === codeCommitWebRoleCheck ? "tsc" : undefined
const browserPairingConsumerLifecycleRequirements = [
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
    script: "prebuild",
    description: "a browser-pairing build",
    matches: (command) => hasExecutableLifecycleCommand(command, browserPairingBuild)
  },
  {
    script: "precheck",
    description: "a browser-pairing build",
    matches: (command) => hasExecutableLifecycleCommand(command, browserPairingBuild)
  },
  {
    script: "prepack",
    description: "a browser-pairing build",
    matches: (command) => hasOrderedPrepackLifecycleCommand(command)
  },
  {
    script: "check",
    description: "the role-aware tsc check",
    matches: (command) => hasExecutableLifecycleCommand(command, codeCommitWebRoleCheck)
  }
]
const codeCommitWebLifecycleRequirements = browserPairingConsumerLifecycleRequirements
const controlCenterRoleCheck = (command) => hasReachableLifecycleCommand(command, codeCommitWebRoleCheck)
const controlCenterLifecycleRequirements = browserPairingConsumerLifecycleRequirements
  .filter(({ script }) => ["predev", "pretest", "prebuild", "precheck", "check"].includes(script))
  .map((requirement) =>
    requirement.script === "check" ? { ...requirement, matches: controlCenterRoleCheck } : requirement
  )
const codeCommitLifecycleRequirements = ["prebuild", "precheck", "prestart", "prestart:web", "pretest", "prepack"].map(
  (script) => ({
    script,
    description: "a browser-pairing build",
    matches: (command) => hasExecutableLifecycleCommand(command, browserPairingBuild)
  })
)

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

const rebaseShellSegments = (segments, offset) =>
  offset === 0
    ? segments
    : segments.map((segment) => ({ ...segment, start: segment.start + offset, end: segment.end + offset }))

const functionDefinitionPattern =
  /(?:^|[;\n]|&&|\|\||[|&({])\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*(\{|\()/gu

const foldShellContinuations = (command) => {
  let result = ""
  let quote
  for (let index = 0; index < command.length; index++) {
    const character = command[index]
    if (character === "\\" && quote !== "'" && command[index + 1] === "\n") {
      index++
      continue
    }
    result += character
    if (quote === undefined && (character === "'" || character === '"')) quote = character
    else if (quote === character) quote = undefined
  }
  return result
}

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
  const source = foldShellContinuations(removeShellComments(removeHereDocumentBodies(command)))
  const definitions = []
  functionDefinitionPattern.lastIndex = 0
  for (const match of source.matchAll(functionDefinitionPattern)) {
    const name = match[1]
    const opener = match[match.length - 1]
    const openIndex = match.index + match[0].length - 1
    const closeIndex = matchingBrace(source, openIndex, opener, opener === "{" ? "}" : ")")
    if (closeIndex === undefined) continue
    const nameIndex = source.indexOf(name, match.index)
    definitions.push({
      name,
      start: nameIndex,
      end: closeIndex + 1,
      body: source.slice(openIndex + 1, closeIndex),
      grouped: ["{", "("].includes(match[0][0] ?? ""),
      reachable: !/(?:^|[;\n])(?:true\s*\|\||false\s*&&)\s*$/u.test(source.slice(0, nameIndex))
    })
    functionDefinitionPattern.lastIndex = closeIndex + 1
  }
  let withoutDefinitions = source
  for (const definition of definitions.toReversed()) {
    withoutDefinitions = `${withoutDefinitions.slice(0, definition.start)}${" ".repeat(definition.end - definition.start)}${withoutDefinitions.slice(definition.end)}`
  }
  return { definitions, source: withoutDefinitions }
}

const shellWords = (text) => {
  const words = []
  let word = ""
  let hasWord = false
  let quote
  const source = text.trim()
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    const nextCharacter = source[index + 1]
    if (character === "\\" && quote !== "'") {
      if (nextCharacter === "\n") {
        index++
        continue
      }
      if (nextCharacter === undefined) return undefined
      if (quote === '"' && !["$", "`", '"', "\\", "\n"].includes(nextCharacter)) {
        word += "\\"
      }
      word += nextCharacter
      hasWord = true
      index++
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else word += character
      hasWord = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      hasWord = true
      continue
    }
    if (/\s/u.test(character)) {
      if (hasWord) {
        words.push(word)
        word = ""
        hasWord = false
      }
      continue
    }
    word += character
    hasWord = true
  }
  if (quote !== undefined) return undefined
  if (hasWord) words.push(word)
  return words
}

const hasUnquotedShellExpansion = (text) => {
  let quote
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
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
      else if (
        quote === '"' &&
        ((character === "$" && /(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*?#$!-]|\(|\{)/u.test(text.slice(index + 1))) ||
          character === "`")
      ) {
        return true
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === "$" && /(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*?#$!-]|\(|\{)/u.test(text.slice(index + 1))) {
      return true
    }
    if (character === "`") return true
  }
  return false
}

const firstShellWord = (text) => {
  const word = shellWords(text)?.[0]
  return word !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(word) ? word : undefined
}

const redirectionWord = /^(?:\d+)?(?:>>?|<<<?|<>|>&|<&|>\|)/u
const separatedRedirectionWord = /^(?:\d+)?(?:>>?|<<<?|<>|>&|<&|>\|)$/u
const assignmentWord = /^[A-Za-z_][A-Za-z0-9_]*=/u

const hasPotentiallyFailingRedirection = (text) => {
  if (shellWords(text) === undefined) return true
  let quote
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
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
    if (character !== ">" && character !== "<") continue
    const operator = text.slice(index).match(/^(>>?|<<<?|<>|>&|<&|>\|)/u)?.[1]
    if (operator === undefined) return true
    index += operator.length - 1
    if (operator.startsWith("<<")) continue
    let operandIndex = index + 1
    while (/\s/u.test(text[operandIndex] ?? "")) operandIndex++
    if (operandIndex >= text.length) return true
    const operandStart = operandIndex
    let operandQuote
    while (operandIndex < text.length) {
      const operandCharacter = text[operandIndex]
      if (operandQuote !== undefined) {
        if (operandCharacter === operandQuote) operandQuote = undefined
      } else if (operandCharacter === "'" || operandCharacter === '"') {
        operandQuote = operandCharacter
      } else if (/\s|[;|&(){}]/u.test(operandCharacter)) {
        break
      }
      operandIndex++
    }
    if (operandQuote !== undefined) return true
    const operand = text.slice(operandStart, operandIndex).replaceAll(/['"]/gu, "")
    if (operator.includes("&")) {
      if (/^[0-9-]+$/u.test(operand)) continue
      return true
    }
    if (operand === "/dev/null") continue
    return true
  }
  return false
}

const firstExecutableWordInfo = (text) => {
  const words = shellWords(text)
  if (words === undefined) return undefined
  let redirectionOperand = false
  for (const [index, word] of words.entries()) {
    if (redirectionOperand) {
      redirectionOperand = false
      continue
    }
    if (redirectionWord.test(word)) {
      redirectionOperand = separatedRedirectionWord.test(word)
      continue
    }
    if (assignmentWord.test(word)) continue
    return { index, word }
  }
  return undefined
}

const firstExecutableWord = (text) => {
  const word = firstExecutableWordInfo(text)?.word
  return word !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(word) ? word : undefined
}

const hasDynamicExecutableIdentity = (text) => {
  const words = shellWords(text)
  const commandInfo = firstExecutableWordInfo(text)
  if (words === undefined || commandInfo === undefined) return words === undefined
  const commandName = commandInfo.word
  if (hasUnquotedShellExpansion(text.slice(0, text.indexOf(commandName) + commandName.length))) return true
  if (commandName === "alias" || commandName === "unalias") {
    return hasUnquotedShellExpansion(text.slice(text.indexOf(commandName) + commandName.length))
  }
  return false
}

const hasPathMutation = (text, start = 0, aliases = []) => {
  const words = shellWords(text)
  if (words === undefined) return true
  const executableIndex = firstExecutableWordInfo(text)?.index ?? words.length
  const assignments = words.slice(0, executableIndex)
  const commandName = resolvedShellCommandName(text, start, aliases)
  const argumentsAfterCommand = words.slice(executableIndex + 1)
  return (
    assignments.some((word) => word.startsWith("PATH=")) ||
    (commandName === "export" && argumentsAfterCommand.some((word) => word.startsWith("PATH="))) ||
    (commandName === "readonly" && argumentsAfterCommand.some((word) => word.startsWith("PATH="))) ||
    (["local", "typeset"].includes(commandName ?? "") && argumentsAfterCommand.some((word) => word.startsWith("PATH=")))
  )
}

const extractAliasMutations = (segments, reachability, aliases = [], offset = 0) => {
  const mutations = []
  for (const [index, segment] of segments.entries()) {
    if (!reachability[index]) continue
    const words = shellWords(segment.text)
    if (words === undefined) return undefined
    const start = offset + segment.start
    const body = groupedCommandBody(segment.text)
    if (body !== undefined && segment.text.trim().startsWith("{")) {
      const bodyOffset = start + segment.text.indexOf(body)
      const bodySegments = shellCommandSegments(body, true)
      const bodyAliases = aliases.map((alias) => ({ ...alias, start: alias.start - bodyOffset }))
      const bodyReachability = segmentReachability(bodySegments, [], bodyAliases)
      const nested = extractAliasMutations(bodySegments, bodyReachability, aliases, bodyOffset)
      if (nested === undefined) return undefined
      mutations.push(...nested)
      continue
    }
    if (hasDynamicExecutableIdentity(segment.text)) return undefined
    const commandName = resolvedShellCommandName(segment.text, start, aliases)
    if (commandName !== "alias" && commandName !== "unalias") continue
    const resolvedWords = resolvedShellCommandWords(segment.text, start, aliases)
    if (resolvedWords === undefined) return undefined
    for (const word of resolvedWords.slice(1)) {
      const name = word.replace(/=.*$/u, "")
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        if (word.includes("=")) return undefined
        continue
      }
      if (commandName === "alias" && word.includes("=")) {
        mutations.push({ kind: "define", name, value: word.slice(word.indexOf("=") + 1), start })
      }
      if (commandName === "unalias") mutations.push({ kind: "remove", name, start })
    }
  }
  return mutations
}

const activeAliasDefinition = (text, start, aliases) => {
  const commandName = firstExecutableWord(text)
  if (commandName === undefined) return undefined
  return aliases
    .filter((alias) => alias.name === commandName && alias.start <= start)
    .toSorted((left, right) => left.start - right.start)
    .at(-1)
}

const hasActiveAliasDefinition = (text, start, aliases) =>
  activeAliasDefinition(text, start, aliases)?.kind === "define"

const resolvedShellCommandName = (text, start, aliases, visited = new Set()) => {
  const commandName = firstExecutableWord(text)
  if (commandName === undefined) return undefined
  const active = aliases
    .filter((alias) => alias.name === commandName && alias.start <= start)
    .toSorted((left, right) => left.start - right.start)
    .at(-1)
  if (active?.kind === "define" && !isSimpleAliasValue(active.value)) return undefined
  if (active?.kind !== "define") return commandName
  if (visited.has(active.name)) return undefined
  return resolvedShellCommandName(active.value, start, aliases, new Set([...visited, active.name]))
}

const aliasCommandResult = (text, start, aliases) => {
  const commandName = resolvedShellCommandName(text, start, aliases)
  if (commandName === ":" || commandName === "true") return "success"
  if (commandName === "false") return "failure"
  return undefined
}

const isShellTerminatingCommand = (text, start = 0, includeReturn = true, aliases = []) => {
  const commandName = resolvedShellCommandName(text, start, aliases)
  return commandName !== undefined && ["exec", "exit", ...(includeReturn ? ["return"] : [])].includes(commandName)
}

const hasActiveFunctionDefinition = (text, start, definitions, aliases = []) => {
  const commandName = resolvedShellCommandName(text, start, aliases)
  return (
    commandName !== undefined &&
    definitions.some(({ name, end, reachable }) => name === commandName && end <= start && reachable !== false)
  )
}

const segmentReachability = (segments, definitions = [], aliases = []) => {
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
      const aliasedResult = aliasCommandResult(text, segment.start, aliases)
      previousResult =
        aliasedResult !== undefined
          ? aliasedResult
          : text === "true"
            ? "success"
            : text === "false"
              ? "failure"
              : isKnownSuccessfulShellCommand(text, segment.start, definitions, aliases)
                ? "success"
                : "unknown"
      if (isShellTerminatingCommand(text, segment.start, true, aliases)) terminated = true
    }
  }
  return reachability
}

const segmentMayReachability = (segments, definitions = [], aliases = []) => {
  const reachability = []
  let previousResult = "unknown"
  let terminated = false
  for (const [index, segment] of segments.entries()) {
    const reachable =
      !terminated &&
      (index === 0 ||
        (segment.operator === "&&" && previousResult !== "failure") ||
        (segment.operator === "||" && previousResult !== "success") ||
        (segment.operator !== "&&" && segment.operator !== "||"))
    reachability.push(reachable)
    const text = segment.text.trim()
    if (reachable) {
      const aliasedResult = aliasCommandResult(text, segment.start, aliases)
      previousResult =
        aliasedResult !== undefined
          ? aliasedResult
          : text === "true"
            ? "success"
            : text === "false"
              ? "failure"
              : isKnownSuccessfulShellCommand(text, segment.start, definitions, aliases)
                ? "success"
                : "unknown"
      if (isShellTerminatingCommand(text, segment.start, true, aliases)) terminated = true
    }
  }
  return reachability
}

const segmentRequiredReachability = (segments, definitions = [], aliases = []) => {
  const reachability = []
  let previousResult = "unknown"
  let terminated = false
  for (const [index, segment] of segments.entries()) {
    const reachable =
      !terminated &&
      (index === 0 ||
        (segment.operator === "&&" && previousResult !== "failure") ||
        (segment.operator === "||" && previousResult === "failure") ||
        (segment.operator !== "&&" && segment.operator !== "||"))
    reachability.push(reachable)
    const text = segment.text.trim()
    if (reachable) {
      const aliasedResult = aliasCommandResult(text, segment.start, aliases)
      previousResult =
        aliasedResult !== undefined
          ? aliasedResult
          : text === "true"
            ? "success"
            : text === "false"
              ? "failure"
              : isKnownSuccessfulShellCommand(text, segment.start, definitions, aliases)
                ? "success"
                : "unknown"
      if (isShellTerminatingCommand(text, segment.start, true, aliases)) terminated = true
    }
  }
  return reachability
}

// A command whose failure already fails the lifecycle may continue on its success path.
const isKnownSuccessfulShellCommand = (text, start, definitions, aliases = []) =>
  !hasActiveFunctionDefinition(text, start, definitions, aliases) &&
  !hasActiveAliasDefinition(text, start, aliases) &&
  !hasPotentiallyFailingRedirection(text) &&
  (/^(?:true|printf|echo|:)(?:\s|$)/u.test(text.trim()) ||
    browserPairingBuild.test(text.trim()) ||
    codeCommitWebRoleCheck.test(text.trim()) ||
    /^tsc\s+-b(?:\s|$)/u.test(text.trim()))

const scanErrexitLifecycle = (segments, definitions, aliases, matcher, inheritedErrexit = false, offset = 0) => {
  const scopedSegments = rebaseShellSegments(segments, offset)
  const mayReachability = segmentMayReachability(scopedSegments, definitions, aliases)
  let errexit = inheritedErrexit
  let risky = false
  let result = "success"
  for (const [index, segment] of scopedSegments.entries()) {
    if (!mayReachability[index]) continue
    const text = segment.text.trim()
    if (text === "") continue
    const transition = setErrexitTransition(text, segment.start, aliases)
    if (transition !== undefined) {
      errexit = transition
      risky = false
      result = "success"
      continue
    }
    if (errexit && risky && matcher.test(text)) return { risk: true, risky, errexit, result }
    let segmentResult = aliasCommandResult(text, segment.start, aliases)
    if (segmentResult === undefined) {
      segmentResult = isKnownSuccessfulShellCommand(text, segment.start, definitions, aliases)
        ? "success"
        : text === "false"
          ? "failure"
          : "unknown"
    }
    const body = groupedCommandBody(text)
    if (body !== undefined) {
      const nested = scanErrexitLifecycle(
        shellCommandSegments(body, true),
        definitions,
        aliases,
        matcher,
        errexit,
        segment.start + segment.text.indexOf(body)
      )
      if (nested.risk) return nested
      segmentResult = nested.result
      if (text.startsWith("{")) {
        risky = nested.risky
        errexit = nested.errexit
      }
    }
    const invokedDefinition = definitions
      .filter(
        (definition) =>
          definition.name === resolvedShellCommandName(text, segment.start, aliases) &&
          definition.end <= segment.start &&
          definition.reachable !== false
      )
      .at(-1)
    if (invokedDefinition !== undefined) {
      const nested = scanErrexitLifecycle(
        shellCommandSegments(invokedDefinition.body, true),
        definitions,
        aliases,
        matcher,
        errexit,
        invokedDefinition.start
      )
      if (nested.risk) return nested
      segmentResult = nested.result
      risky = nested.risky
      errexit = nested.errexit
    }
    const compoundSucceeded = body !== undefined && segmentResult === "success"
    if (
      errexit &&
      (segment.nextOperator === ";" || segment.nextOperator === "\n") &&
      !compoundSucceeded &&
      !isKnownSuccessfulShellCommand(text, segment.start, definitions, aliases)
    ) {
      risky = true
    }
    result = segmentResult
  }
  return { risk: false, risky, errexit, result }
}

const hasErrexitLifecycleRisk = (segments, definitions, aliases, matcher) =>
  scanErrexitLifecycle(segments, definitions, aliases, matcher).risk

const unsupportedShellWords = new Set([
  "builtin",
  "case",
  "command",
  "do",
  "done",
  "enable",
  "esac",
  "eval",
  "fi",
  "for",
  "function",
  "if",
  "select",
  "source",
  "then",
  "trap",
  "until",
  "while"
])

const hasUnsupportedShellControl = (source, aliases = undefined, offset = 0) => {
  const segments = rebaseShellSegments(shellCommandSegments(source, true), offset)
  const resolvedAliases = aliases ?? resolveAliasMutations(segments, [])
  if (resolvedAliases === undefined) return true
  return segments.some(({ text, nextOperator, start }) => {
    const commandName = resolvedShellCommandName(text, start, resolvedAliases)
    if (unsupportedShellWords.has(commandName ?? "")) return true
    if (/^\\?(?:\.|source)(?:\s|$)/u.test(text.trim()) || text.trim().startsWith("!")) return true
    if (nextOperator === "&") return true
    const body = groupedCommandBody(text)
    return body !== undefined && hasUnsupportedShellControl(body, resolvedAliases, start + text.indexOf(body))
  })
}

const shellSetArguments = (text, start = 0, aliases = []) => {
  const words = shellWords(text)
  const commandInfo = firstExecutableWordInfo(text)
  return words !== undefined && resolvedShellCommandName(text, start, aliases) === "set"
    ? words.slice(commandInfo.index + 1)
    : undefined
}

const setOptionTransition = (text, optionName, start = 0, aliases = []) => {
  const argumentsAfterCommand = shellSetArguments(text, start, aliases)
  if (argumentsAfterCommand === undefined) return undefined
  let transition
  for (let index = 0; index < argumentsAfterCommand.length; index++) {
    const word = argumentsAfterCommand[index]
    if (word === "--") break
    if (/(?:\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*?#$!-])|\$\(|\$\{|`)/u.test(word ?? "")) return "unsafe"
    if (word === "-o" || word === "+o") {
      if (
        /(?:\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*?#$!-])|\$\(|\$\{|`)/u.test(argumentsAfterCommand[index + 1] ?? "")
      ) {
        return "unsafe"
      }
      if (argumentsAfterCommand[index + 1] === optionName) transition = word === "-o"
      index++
      continue
    }
    if (optionName === "noexec") {
      if (word === "--noexec" || /^-[^-]*n/u.test(word ?? "")) transition = true
      if (/^\+[^-]*n/u.test(word ?? "")) transition = false
    }
    if (optionName === "errexit") {
      if (/^-[^-]*e/u.test(word ?? "")) transition = true
      if (/^\+[^-]*e/u.test(word ?? "")) transition = false
    }
  }
  return transition
}

const hasNoExecShellOptionInCommand = (command, aliases = undefined, offset = 0) => {
  const { source } = extractFunctionDefinitions(command)
  const segments = rebaseShellSegments(shellCommandSegments(source, true), offset)
  const resolvedAliases = aliases ?? resolveAliasMutations(segments, [])
  if (resolvedAliases === undefined) return true
  const reachability = segmentMayReachability(segments, [], resolvedAliases)
  let enabled = false
  for (const [index, segment] of segments.entries()) {
    if (!reachability[index]) continue
    const transition = setOptionTransition(segment.text, "noexec", segment.start, resolvedAliases)
    if (transition === "unsafe") return true
    if (transition !== undefined) {
      enabled = transition
      continue
    }
    if (enabled) return true
    const body = groupedCommandBody(segment.text)
    if (
      body !== undefined &&
      segment.text.trim().startsWith("{") &&
      hasNoExecShellOptionInCommand(body, resolvedAliases, segment.start + segment.text.indexOf(body))
    )
      return true
  }
  return enabled
}

const setErrexitTransition = (text, start = 0, aliases = []) => {
  const transition = setOptionTransition(text, "errexit", start, aliases)
  return transition === "unsafe" ? undefined : transition
}

const hasCommandCacheMutation = (text, start = 0, aliases = []) => {
  const words = shellWords(text)
  const commandInfo = firstExecutableWordInfo(text)
  if (words === undefined || resolvedShellCommandName(text, start, aliases) !== "hash") return false
  return words.slice(commandInfo.index + 1).some((word) => /^-p(?:$|[^-])/u.test(word))
}

const hasReachableCommandCacheMutation = (command, aliases = undefined, offset = 0) => {
  const { definitions, source } = extractFunctionDefinitions(command)
  const segments = rebaseShellSegments(shellCommandSegments(source, true), offset)
  const resolvedAliases = aliases ?? resolveAliasMutations(segments, definitions)
  if (resolvedAliases === undefined) return true
  const reachability = segmentMayReachability(segments, definitions, resolvedAliases)
  return segments.some(({ text, start }, index) => {
    if (!reachability[index]) return false
    if (hasCommandCacheMutation(text, start, resolvedAliases)) return true
    const body = groupedCommandBody(text)
    return (
      body !== undefined &&
      text.trim().startsWith("{") &&
      hasReachableCommandCacheMutation(body, resolvedAliases, start + text.indexOf(body))
    )
  })
}

const hasInvokedCommand = (source, name, definitions = [], aliases = [], offset = 0) => {
  const segments = rebaseShellSegments(shellCommandSegments(source, true), offset)
  const reachability = segmentReachability(segments, definitions, aliases)
  return segments.some((segment, index) => {
    const { start, text } = segment
    if (!reachability[index]) return false
    if (resolvedShellCommandName(text, start, aliases) === name) return true
    const body = groupedCommandBody(text)
    return body !== undefined && hasInvokedCommand(body, name, definitions, aliases, start + text.indexOf(body))
  })
}

const hasUnsafeInvokedFunction = (
  command,
  visited = new Set(),
  inheritedAliases = [],
  inheritedDefinitions = [],
  offset = 0
) => {
  const { definitions: localDefinitions, source } = extractFunctionDefinitions(command)
  const definitions = [
    ...inheritedDefinitions,
    ...localDefinitions.map((definition) => ({
      ...definition,
      start: definition.start + offset,
      end: definition.end + offset
    }))
  ].filter(
    (definition, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.name === definition.name && candidate.start === definition.start && candidate.end === definition.end
      ) === index
  )
  const segments = rebaseShellSegments(shellCommandSegments(source, true), offset)
  const localAliases = resolveAliasMutations(segments, definitions)
  if (localAliases === undefined) return true
  const aliases = [...inheritedAliases, ...localAliases]
  if (hasUnsupportedShellControl(source, aliases, offset)) return true
  return definitions.some((definition) => {
    if (visited.has(definition.name)) return false
    const invoked = hasInvokedCommand(source, definition.name, definitions, aliases, offset)
    const activeDefinition = definitions
      .filter((candidate) => candidate.name === definition.name && candidate.end <= definition.end)
      .at(-1)
    if (activeDefinition !== definition && !definition.grouped) return false
    return (
      (definition.grouped || invoked) &&
      (hasShellTermination(definition.body, aliases, definition.start) ||
        hasUnsafeInvokedFunction(
          definition.body,
          new Set([...visited, definition.name]),
          aliases,
          definitions,
          definition.start
        ))
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

const isSimpleAliasValue = (value) => {
  const trimmed = value.trim()
  const segments = shellCommandSegments(trimmed, true)
  const segment = segments[0]
  const commandName = firstExecutableWordInfo(trimmed)?.word
  return (
    segments.length === 1 &&
    segment !== undefined &&
    segment.operator === undefined &&
    segment.nextOperator === undefined &&
    groupedCommandBody(trimmed) === undefined &&
    commandName !== undefined &&
    !unsupportedShellWords.has(commandName) &&
    !trimmed.startsWith("!")
  )
}

const hasShellTermination = (command, aliases = [], offset = 0) => {
  const { definitions, source } = extractFunctionDefinitions(command)
  const segments = rebaseShellSegments(shellCommandSegments(source, true), offset)
  const reachability = segmentReachability(segments, definitions, aliases)
  return segments.some((segment, index) => {
    const { text } = segment
    if (!reachability[index]) return false
    const trimmed = text.trim()
    if (isShellTerminatingCommand(trimmed, segment.start, false, aliases)) return true
    const body = groupedCommandBody(trimmed)
    return (
      body !== undefined &&
      trimmed.startsWith("{") &&
      hasShellTermination(body, aliases, segment.start + text.indexOf(body))
    )
  })
}

const sameAliasMutations = (left, right) =>
  left !== undefined &&
  left.length === right.length &&
  left.every(
    (mutation, index) =>
      mutation.kind === right[index]?.kind &&
      mutation.name === right[index]?.name &&
      mutation.value === right[index]?.value &&
      mutation.start === right[index]?.start
  )

const resolveAliasMutations = (segments, definitions) => {
  let aliases = []
  for (let iteration = 0; iteration <= segments.length; iteration += 1) {
    if (aliases.some((alias) => alias.kind === "define" && !isSimpleAliasValue(alias.value))) return undefined
    const mustReachability = segmentReachability(segments, definitions, aliases)
    const next = extractAliasMutations(segments, mustReachability, aliases)
    if (next === undefined) return undefined
    if (sameAliasMutations(next, aliases)) {
      const mayReachability = segmentMayReachability(segments, definitions, aliases)
      if (
        segments.some(
          ({ start, text }, index) =>
            mayReachability[index] &&
            !mustReachability[index] &&
            ["alias", "unalias"].includes(resolvedShellCommandName(text, start, aliases) ?? "")
        )
      )
        return undefined
      return next
    }
    if (
      next.some((mutation) => {
        if (mutation.kind !== "remove") return false
        const segmentIndex = segments.findIndex(({ start, end }) => mutation.start >= start && mutation.start <= end)
        const segment = segments[segmentIndex]
        const following = segments[segmentIndex + 1]
        if (segment?.nextOperator !== ";" || following === undefined) return false
        const priorDefinition = next
          .filter((candidate) => candidate.name === mutation.name && candidate.start < mutation.start)
          .at(-1)
        return priorDefinition?.kind === "define" && firstShellWord(following.text) === mutation.name
      })
    ) {
      return undefined
    }
    aliases = next
  }
  return undefined
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
    !hasPotentiallyFailingRedirection(segments[index]?.text ?? "") &&
    !hasStatusReplacement(segments, index) &&
    !segments.slice(index).some(({ text, nextOperator: followingOperator }) => {
      if (followingOperator === "||") return true
      const body = groupedCommandBody(text)
      return body !== undefined && hasStatusRecoveryOperator(body)
    })) ||
  (nextOperator === ";" && segments.slice(index + 1).every(({ text }) => text.trim() === ""))

const hasReachableGatingRedirection = (segments, reachability) =>
  segments.some(
    ({ text, nextOperator }, index) =>
      reachability[index] && nextOperator === "&&" && hasPotentiallyFailingRedirection(text)
  )

const hasMayReachableTerminationBeforeMatcher = (segments, definitions, aliases, matcher, offset = 0) => {
  const scopedSegments = rebaseShellSegments(segments, offset)
  const mayReachability = segmentMayReachability(scopedSegments, definitions, aliases)
  let terminated = false
  for (const [index, segment] of scopedSegments.entries()) {
    if (!mayReachability[index] && !terminated) continue
    const text = segment.text.trim()
    if (terminated && matcher.test(text)) return true
    const body = groupedCommandBody(text)
    if (
      body !== undefined &&
      text.startsWith("{") &&
      hasReachableShellTermination(
        shellCommandSegments(body, true),
        definitions,
        aliases,
        segment.start + segment.text.indexOf(body)
      )
    ) {
      terminated = true
    }
    if (isShellTerminatingCommand(text, segment.start, true, aliases)) terminated = true
  }
  return false
}

const hasReachableShellTermination = (segments, definitions, aliases, offset = 0) => {
  const scopedSegments = rebaseShellSegments(segments, offset)
  const reachability = segmentMayReachability(scopedSegments, definitions, aliases)
  return scopedSegments.some(({ text, start }, index) => {
    if (!reachability[index]) return false
    if (isShellTerminatingCommand(text.trim(), start, true, aliases)) return true
    const body = groupedCommandBody(text)
    return (
      body !== undefined &&
      text.trim().startsWith("{") &&
      hasReachableShellTermination(shellCommandSegments(body, true), definitions, aliases, start + text.indexOf(body))
    )
  })
}

const hasPersistentPathMutation = (text, start = 0, aliases = []) => {
  if (hasPathMutation(text, start, aliases)) return true
  const trimmed = text.trim()
  const body = groupedCommandBody(text)
  return (
    body !== undefined &&
    trimmed.startsWith("{") &&
    hasPersistentPathMutation(body, start + text.indexOf(body), aliases)
  )
}

const hasReachableExecutableMutation = (command, executableName, visited = new Set()) => {
  if (executableName === undefined) return false
  const { definitions, source } = extractFunctionDefinitions(command)
  if (
    hasUnsupportedShellControl(source) ||
    hasNoExecShellOptionInCommand(command) ||
    hasReachableCommandCacheMutation(command) ||
    hasUnsafeInvokedFunction(command, visited)
  )
    return true
  const segments = shellCommandSegments(source, true)
  const aliases = resolveAliasMutations(segments, definitions)
  if (aliases === undefined) return true
  const reachability = segmentMayReachability(segments, definitions, aliases)
  if (segments.some(({ text }, index) => reachability[index] && hasDynamicExecutableIdentity(text))) return true
  const activeExecutableAlias = aliases
    .filter(({ name }) => name === executableName)
    .toSorted((left, right) => left.start - right.start)
    .at(-1)
  if (
    definitions.some(({ name, reachable }) => name === executableName && reachable !== false) ||
    activeExecutableAlias?.kind === "define" ||
    segments.some(({ text, start }, index) => reachability[index] && hasPersistentPathMutation(text, start, aliases))
  ) {
    return true
  }
  return definitions.some((definition) => {
    if (visited.has(definition.name)) return false
    const invoked = segments.some(({ text, start }, index) => {
      if (!reachability[index] || resolvedShellCommandName(text, start, aliases) !== definition.name) return false
      const activeDefinition = definitions
        .filter((candidate) => candidate.name === definition.name && candidate.end <= start)
        .at(-1)
      return activeDefinition === definition
    })
    return (
      invoked && hasReachableExecutableMutation(definition.body, executableName, new Set([...visited, definition.name]))
    )
  })
}

const hasReachableLifecycleCommand = (command, matcher, visited = new Set()) => {
  const { definitions, source } = extractFunctionDefinitions(command)
  if (
    hasUnsupportedShellControl(source) ||
    hasNoExecShellOptionInCommand(command) ||
    hasReachableCommandCacheMutation(command) ||
    hasUnsafeInvokedFunction(command, visited)
  )
    return false
  const executableName = protectedExecutableName(matcher)
  if (hasReachableExecutableMutation(command, executableName, visited)) return false
  const segments = shellCommandSegments(source, true)
  const aliases = resolveAliasMutations(segments, definitions)
  if (aliases === undefined) return false
  const reachability = segmentRequiredReachability(segments, definitions, aliases)
  if (hasReachableGatingRedirection(segments, reachability)) return false
  if (hasErrexitLifecycleRisk(segments, definitions, aliases, matcher)) return false
  if (hasMayReachableTerminationBeforeMatcher(segments, definitions, aliases, matcher)) return false
  if (segments.some(({ text, start }, index) => reachability[index] && hasPersistentPathMutation(text, start, aliases)))
    return false
  if (
    segments.some(({ text, nextOperator, start }, index) => {
      if (!reachability[index] || !hasStatusSafeContinuation(segments, index, nextOperator)) return false
      if (
        !hasActiveFunctionDefinition(text, start, definitions, aliases) &&
        !hasActiveAliasDefinition(text, start, aliases) &&
        matcher.test(text.trim())
      )
        return true
      const body = groupedCommandBody(text)
      return body !== undefined && hasReachableLifecycleCommand(body, matcher, visited)
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
        resolvedShellCommandName(text, start, aliases) !== definition.name
      ) {
        return false
      }
      const activeDefinition = definitions
        .filter((candidate) => candidate.name === definition.name && candidate.end <= start)
        .at(-1)
      return activeDefinition === definition
    })
    return invoked && hasReachableLifecycleCommand(definition.body, matcher, new Set([...visited, definition.name]))
  })
}

const hasExecutableLifecycleCommand = (command, matcher, visited = new Set()) => {
  const { definitions, source } = extractFunctionDefinitions(command)
  if (
    hasUnsupportedShellControl(source) ||
    hasNoExecShellOptionInCommand(command) ||
    hasReachableCommandCacheMutation(command) ||
    hasUnsafeInvokedFunction(command, visited)
  )
    return false
  const executableName = protectedExecutableName(matcher)
  if (hasReachableExecutableMutation(command, executableName, visited)) return false
  const segments = shellCommandSegments(source, true)
  const aliases = resolveAliasMutations(segments, definitions)
  if (aliases === undefined) return false
  const reachability = segmentReachability(segments, definitions, aliases)
  if (hasReachableGatingRedirection(segments, reachability)) return false
  if (hasErrexitLifecycleRisk(segments, definitions, aliases, matcher)) return false
  if (hasMayReachableTerminationBeforeMatcher(segments, definitions, aliases, matcher)) return false
  if (segments.some(({ text, start }, index) => reachability[index] && hasPersistentPathMutation(text, start, aliases)))
    return false
  if (
    segments.some(({ text, nextOperator, start }, index) => {
      if (!reachability[index] || !hasStatusSafeContinuation(segments, index, nextOperator)) {
        return false
      }
      if (
        !hasActiveFunctionDefinition(text, start, definitions, aliases) &&
        !hasActiveAliasDefinition(text, start, aliases) &&
        matcher.test(text.trim())
      )
        return true
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
        resolvedShellCommandName(text, start, aliases) !== definition.name
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

const resolvedShellCommandWords = (text, start, aliases, visited = new Set()) => {
  const words = shellWords(text)
  const commandInfo = firstExecutableWordInfo(text)
  if (words === undefined || commandInfo === undefined) return undefined
  const active = aliases
    .filter((alias) => alias.name === commandInfo.word && alias.start <= start)
    .toSorted((left, right) => left.start - right.start)
    .at(-1)
  if (active?.kind === "define" && (!isSimpleAliasValue(active.value) || visited.has(active.name))) return undefined
  const commandWords =
    active?.kind === "define"
      ? resolvedShellCommandWords(active.value, start, aliases, new Set([...visited, active.name]))
      : [resolvedShellCommandName(text, start, aliases)]
  if (commandWords === undefined || commandWords[0] === undefined) return undefined
  return [...commandWords, ...words.slice(commandInfo.index + 1)]
}

const isPrepackCompilationCommand = (text, start, aliases) => {
  const words = resolvedShellCommandWords(text, start, aliases)
  const commandName = words?.[0]
  return (commandName === "tsc" && words?.[1] === "-b") || (commandName === "vite" && words?.[1] === "build")
}

const hasOrderedPrepackLifecycleCommand = (command) => {
  if (!hasExecutableLifecycleCommand(command, browserPairingBuild)) return false
  const { definitions, source } = extractFunctionDefinitions(command)
  const segments = shellCommandSegments(source, true)
  const aliases = resolveAliasMutations(segments, definitions)
  if (aliases === undefined) return false
  const visited = new Set()
  const definitionKey = (definition) => `${definition.name}:${definition.start}:${definition.end}`
  const scan = (nestedSegments, inheritedBuild, offset = 0) => {
    const scopedSegments = rebaseShellSegments(nestedSegments, offset)
    const reachability = segmentRequiredReachability(scopedSegments, definitions, aliases)
    let buildSeen = inheritedBuild
    for (const [index, segment] of scopedSegments.entries()) {
      if (!reachability[index]) continue
      const text = segment.text.trim()
      if (
        !hasActiveFunctionDefinition(text, segment.start, definitions, aliases) &&
        !hasActiveAliasDefinition(text, segment.start, aliases) &&
        browserPairingBuild.test(text)
      ) {
        buildSeen = true
      }
      if (isPrepackCompilationCommand(text, segment.start, aliases) && !buildSeen) {
        return { valid: false, buildSeen }
      }
      const body = groupedCommandBody(text)
      if (body !== undefined) {
        const nestedBuild = scan(
          shellCommandSegments(body, true),
          buildSeen,
          segment.start + segment.text.indexOf(body)
        )
        if (!nestedBuild.valid) return nestedBuild
        buildSeen = nestedBuild.buildSeen
      }
      const definition = definitions
        .filter(
          (candidate) =>
            candidate.name === resolvedShellCommandName(text, segment.start, aliases) &&
            candidate.end <= segment.start &&
            candidate.reachable !== false
        )
        .at(-1)
      if (definition !== undefined && !visited.has(definitionKey(definition))) {
        visited.add(definitionKey(definition))
        const nestedBuild = scan(shellCommandSegments(definition.body, true), buildSeen, definition.start)
        if (!nestedBuild.valid) return nestedBuild
        buildSeen = nestedBuild.buildSeen
      }
    }
    return { valid: true, buildSeen }
  }
  return scan(segments, false).valid
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
  const requirements =
    manifestPath === "packages/codecommit-web/package.json"
      ? codeCommitWebLifecycleRequirements
      : manifestPath === "packages/control-center/package.json"
        ? controlCenterLifecycleRequirements
        : undefined
  if (requirements === undefined || !("@knpkv/browser-pairing" in { ...dependencies, ...devDependencies })) {
    return []
  }
  const result = requirements
    .filter(({ script, matches }) => !matches(scripts?.[script] ?? ""))
    .map(({ script, description }) => `${manifestPath}: scripts.${script} must include ${description}`)
  return result
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
  prebuild: "pnpm --filter @knpkv/browser-pairing build",
  precheck: "pnpm --filter @knpkv/browser-pairing build",
  pretest: "pnpm --filter @knpkv/browser-pairing build",
  prepack: "pnpm --filter @knpkv/browser-pairing build && tsc -b && vite build",
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
    { ...codeCommitWebScripts, predev: "alias stop=printf\n{ stop 0; }; pnpm --filter @knpkv/browser-pairing build" },
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
    { ...codeCommitWebScripts, predev: "alias pnpm=true\npnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: 'co"mmand" alias pnpm=true\npnpm --filter @knpkv/browser-pairing build' },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: 'co"mmand" alias tsc=true\ntsc -p tsconfig.roles.json --noEmit' },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: String.raw`co"m\
mand" alias pnpm=:; pnpm --filter @knpkv/browser-pairing build`
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
      check: String.raw`co"m\
mand" alias tsc=:; tsc -p tsconfig.roles.json --noEmit`
    },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: 'a"lias" pnpm=true\npnpm --filter @knpkv/browser-pairing build' },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: 'a"lias" tsc=true\ntsc -p tsconfig.roles.json --noEmit' },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: "alias pnpm=:; alias true=false; true && unalias pnpm; pnpm --filter @knpkv/browser-pairing build"
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
      predev: "alias pnpm=true\nfalse && unalias pnpm\npnpm --filter @knpkv/browser-pairing build"
    },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "alias pnpm=true\nunalias pnpm\npnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: "alias tsc=true\ntsc -p tsconfig.roles.json --noEmit" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "alias helper=true\npnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  []
)
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
    {
      ...codeCommitWebScripts,
      predev: "test -e package.json && alias pnpm=:\npnpm --filter @knpkv/browser-pairing build"
    },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "false && alias pnpm=:\npnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: "alias pnpm=:; alias unalias=:; unalias pnpm; pnpm --filter @knpkv/browser-pairing build"
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
      predev:
        "alias pnpm=:; alias gate=false; alias false=true; gate || unalias pnpm; pnpm --filter @knpkv/browser-pairing build"
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
      predev: "alias pnpm=:; alias gate=false; gate || unalias pnpm\npnpm --filter @knpkv/browser-pairing build"
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
      predev: "alias pnpm=:\nunalias pnpm; pnpm --filter @knpkv/browser-pairing build"
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
      predev: "alias pnpm=:\nunalias pnpm\npnpm --filter @knpkv/browser-pairing build"
    },
    browserPairingDependency
  ),
  []
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
    { ...codeCommitWebScripts, predev: "pnpm() ( true ); pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "function pnpm { true; }; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
for (const aliasCommand of ["alias 'pnpm=:'", 'alias "pnpm=:"']) {
  assert.deepEqual(
    findCodeCommitWebLifecycleGaps(
      "packages/codecommit-web/package.json",
      { ...codeCommitWebScripts, predev: `${aliasCommand}; pnpm --filter @knpkv/browser-pairing build` },
      browserPairingDependency
    ),
    ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
  )
}
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: String.raw`e\xit 0; pnpm --filter @knpkv/browser-pairing build` },
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
  []
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
    { ...codeCommitWebScripts, predev: "stop() { exit 0; }; e\\val stop; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, check: "sour\\ce ./stop.sh; tsc -p tsconfig.roles.json --noEmit" },
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
  prebuild: "pnpm --filter @knpkv/browser-pairing build",
  precheck: "pnpm --filter @knpkv/browser-pairing build",
  prestart: "pnpm --filter @knpkv/browser-pairing build",
  "prestart:web": "pnpm --filter @knpkv/browser-pairing build",
  pretest: "pnpm --filter @knpkv/browser-pairing build",
  prepack: "pnpm --filter @knpkv/browser-pairing build && tsc -b"
}
assert.deepEqual(findCodeCommitWebLifecycleGaps("packages/codecommit/package.json", codeCommitScripts, {}), [])
assert.deepEqual(
  findCodeCommitWebLifecycleGaps("packages/codecommit/package.json", { ...codeCommitScripts, prebuild: "tsc -b" }, {}),
  ["packages/codecommit/package.json: scripts.prebuild must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit/package.json",
    { ...codeCommitScripts, precheck: "tsc -b tsconfig.json" },
    {}
  ),
  ["packages/codecommit/package.json: scripts.precheck must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps("packages/codecommit/package.json", { ...codeCommitScripts, prepack: "tsc -b" }, {}),
  ["packages/codecommit/package.json: scripts.prepack must include a browser-pairing build"]
)
for (const [script, command, description] of [
  ["predev", "$(printf alias) pnpm=true; pnpm --filter @knpkv/browser-pairing build", "a browser-pairing build"],
  [
    "predev",
    "builtin=alias; ${builtin} pnpm=true; pnpm --filter @knpkv/browser-pairing build",
    "a browser-pairing build"
  ],
  ["predev", "name=pnpm; alias ${name}=true; pnpm --filter @knpkv/browser-pairing build", "a browser-pairing build"],
  [
    "predev",
    "setup() { pnpm() { :; }; }; setup; pnpm --filter @knpkv/browser-pairing build",
    "a browser-pairing build"
  ],
  [
    "predev",
    "setup() { local PATH=/tmp/fake; pnpm --filter @knpkv/browser-pairing build; }; setup",
    "a browser-pairing build"
  ],
  ["predev", "{ alias pnpm=:; }\npnpm --filter @knpkv/browser-pairing build", "a browser-pairing build"],
  [
    "predev",
    "printf ready; alias stop=exit\nstop 0; pnpm --filter @knpkv/browser-pairing build",
    "a browser-pairing build"
  ],
  ["predev", "set -n; pnpm --filter @knpkv/browser-pairing build", "a browser-pairing build"],
  ["predev", "set -o noexec; pnpm --filter @knpkv/browser-pairing build", "a browser-pairing build"]
]) {
  assert.deepEqual(
    findCodeCommitWebLifecycleGaps(
      "packages/codecommit-web/package.json",
      { ...codeCommitWebScripts, [script]: command },
      browserPairingDependency
    ),
    [`packages/codecommit-web/package.json: scripts.${script} must include ${description}`]
  )
}
const lifecycleGap = (script) =>
  `packages/codecommit-web/package.json: scripts.${script} must include a browser-pairing build`
for (const command of [
  "set -e; false; pnpm --filter @knpkv/browser-pairing build",
  "set -en; pnpm --filter @knpkv/browser-pairing build",
  'set -o "$opts"; pnpm --filter @knpkv/browser-pairing build',
  "alias disable=set\ndisable -n\npnpm --filter @knpkv/browser-pairing build",
  "set -- alias\n$1 pnpm=:\npnpm --filter @knpkv/browser-pairing build",
  "hash -p /usr/bin/true pnpm; pnpm --filter @knpkv/browser-pairing build",
  "alias cache=hash\ncache -p /usr/bin/true pnpm\npnpm --filter @knpkv/browser-pairing build",
  "stop() { exit 0; }; builtin eval stop; pnpm --filter @knpkv/browser-pairing build",
  "enable -f ./fake-pnpm.so pnpm; pnpm --filter @knpkv/browser-pairing build",
  "alias invoke=builtin\ninvoke eval stop\npnpm --filter @knpkv/browser-pairing build",
  "alias invoke=wrapper\nalias wrapper=builtin\ninvoke eval stop\npnpm --filter @knpkv/browser-pairing build",
  "alias loader=enable\nloader -f ./fake-pnpm.so pnpm\npnpm --filter @knpkv/browser-pairing build",
  "alias loader=wrapper\nalias wrapper=enable\nloader -f ./fake-pnpm.so pnpm\npnpm --filter @knpkv/browser-pairing build",
  "alias gate=true\n{ gate && alias pnpm=:; }\npnpm --filter @knpkv/browser-pairing build",
  "alias options=set\noptions -n\npnpm --filter @knpkv/browser-pairing build",
  "alias decl=export\ndecl PATH=/tmp/fake\npnpm --filter @knpkv/browser-pairing build",
  "{ exit 0; }; pnpm --filter @knpkv/browser-pairing build",
  "alias stop=exit\n{ stop 0; }; pnpm --filter @knpkv/browser-pairing build",
  "stop() { exit 0; }\nalias invoke=stop\n{ invoke; }\npnpm --filter @knpkv/browser-pairing build",
  "alias invoke=stop\nstop() { exit 0; }\nwrapper() { { invoke; }; }\nwrapper\npnpm --filter @knpkv/browser-pairing build",
  "set -e; { false; pnpm --filter @knpkv/browser-pairing build; }",
  "set -e; fail() { false; }; fail; pnpm --filter @knpkv/browser-pairing build",
  "builtin=alias\n$builtin pnpm=:\npnpm --filter @knpkv/browser-pairing build",
  "alias helper=$1\nhelper pnpm\npnpm --filter @knpkv/browser-pairing build",
  "alias define=alias\ndefine pnpm=:\npnpm --filter @knpkv/browser-pairing build",
  "alias define='alias pnpm=:'\ndefine\npnpm --filter @knpkv/browser-pairing build",
  "alias define=': && alias pnpm=:'\ndefine\npnpm --filter @knpkv/browser-pairing build",
  "alias define=alias\ntest -e package.json && define pnpm=:\npnpm --filter @knpkv/browser-pairing build",
  "f() { alias pnpm=:; }; alias invoke=f\ninvoke\npnpm --filter @knpkv/browser-pairing build",
  "true x>/definitely/not/present/output && pnpm --filter @knpkv/browser-pairing build",
  '"`printf alias`" pnpm=:; pnpm --filter @knpkv/browser-pairing build',
  "> /dev/null local PATH=/tmp/fake; pnpm --filter @knpkv/browser-pairing build",
  "test -e package.json && exit 0; pnpm --filter @knpkv/browser-pairing build"
]) {
  const result = findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: command },
    browserPairingDependency
  )
  assert.deepEqual(result, [lifecycleGap("predev")])
}
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: "true > /definitely/not/present/output && pnpm --filter @knpkv/browser-pairing build"
    },
    browserPairingDependency
  ),
  [lifecycleGap("predev")]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "setup() { local FOO=1; pnpm --filter @knpkv/browser-pairing build; }; setup" },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "{ alias helper=:; }\npnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: "printf ready; alias stop=printf\nstop 0; pnpm --filter @knpkv/browser-pairing build"
    },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "set -- value; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, prepack: "tsc -b && vite build" },
    browserPairingDependency
  ),
  [lifecycleGap("prepack")]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, prepack: "tsc -b && pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  [lifecycleGap("prepack")]
)
for (const command of [
  "X=1 tsc -b; pnpm --filter @knpkv/browser-pairing build && vite build",
  "alias compile=tsc\ncompile -b\npnpm --filter @knpkv/browser-pairing build && vite build",
  "alias wrapper=tsc\nalias compile=wrapper\ncompile -b\npnpm --filter @knpkv/browser-pairing build && vite build",
  "printf ready; alias compile=tsc\n{ compile -b; }; pnpm --filter @knpkv/browser-pairing build && vite build",
  "f() { :; }; f; f() { tsc -b; }; f; pnpm --filter @knpkv/browser-pairing build && vite build"
]) {
  assert.deepEqual(
    findCodeCommitWebLifecycleGaps(
      "packages/codecommit-web/package.json",
      { ...codeCommitWebScripts, prepack: command },
      browserPairingDependency
    ),
    [lifecycleGap("prepack")]
  )
}
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, prepack: "pnpm --filter @knpkv/browser-pairing build && X=1 tsc -b && vite build" },
    browserPairingDependency
  ),
  []
)
for (const [command, expected] of [
  ["set -e; pnpm --filter @knpkv/browser-pairing build", []],
  ["(set -n); pnpm --filter @knpkv/browser-pairing build", []],
  ["set -n; set +n; pnpm --filter @knpkv/browser-pairing build", []],
  ["set -e; set +e; false; pnpm --filter @knpkv/browser-pairing build", []],
  ["set -e; echo ready; pnpm --filter @knpkv/browser-pairing build", []],
  ["set -e; { true; pnpm --filter @knpkv/browser-pairing build; }", []],
  ["set -e; { true; }; pnpm --filter @knpkv/browser-pairing build", []],
  ["(exit 0); pnpm --filter @knpkv/browser-pairing build", []],
  ["printf '$builtin'; pnpm --filter @knpkv/browser-pairing build", []],
  ["printf '$1'; pnpm --filter @knpkv/browser-pairing build", []],
  ["alias helper='$1'\npnpm --filter @knpkv/browser-pairing build", []],
  ["'`printf alias`' pnpm=:; pnpm --filter @knpkv/browser-pairing build", []],
  ["alias disable=printf\ndisable -n\npnpm --filter @knpkv/browser-pairing build", []],
  ["alias options=printf\noptions -n\npnpm --filter @knpkv/browser-pairing build", []],
  ["alias decl=printf\ndecl PATH=/tmp/fake\npnpm --filter @knpkv/browser-pairing build", []],
  ["alias cache=printf\ncache -p /usr/bin/true pnpm\npnpm --filter @knpkv/browser-pairing build", []],
  ["alias invoke=printf\ninvoke eval stop\npnpm --filter @knpkv/browser-pairing build", []],
  ["alias define=printf\ndefine pnpm=:\npnpm --filter @knpkv/browser-pairing build", []],
  ["alias define='printf pnpm=:'\ndefine\npnpm --filter @knpkv/browser-pairing build", []],
  ["alias define=alias\nfalse && define pnpm=:\npnpm --filter @knpkv/browser-pairing build", []],
  ["f() { FOO=1; }; alias invoke=f\ninvoke\npnpm --filter @knpkv/browser-pairing build", []],
  ["alias loader=printf\nloader -f ./fake-pnpm.so pnpm\npnpm --filter @knpkv/browser-pairing build", []],
  [
    "alias loader=wrapper\nalias wrapper=printf\nloader -f ./fake-pnpm.so pnpm\npnpm --filter @knpkv/browser-pairing build",
    []
  ],
  ["alias gate=false\n{ gate && alias pnpm=:; }\npnpm --filter @knpkv/browser-pairing build", []],
  ["> /dev/null local FOO=1; pnpm --filter @knpkv/browser-pairing build", []],
  ["true >/dev/null && pnpm --filter @knpkv/browser-pairing build", []],
  ["printf ready > build.log; pnpm --filter @knpkv/browser-pairing build", []],
  [
    "alias wrapper=printf\nalias compile=wrapper\ncompile -b\npnpm --filter @knpkv/browser-pairing build && vite build",
    []
  ],
  ["printf ready; alias compile=printf\n{ compile -b; }; pnpm --filter @knpkv/browser-pairing build && vite build", []]
]) {
  assert.deepEqual(
    findCodeCommitWebLifecycleGaps(
      "packages/codecommit-web/package.json",
      { ...codeCommitWebScripts, predev: command },
      browserPairingDependency
    ),
    expected
  )
}
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/control-center/package.json",
    {
      predev: "pnpm --filter @knpkv/browser-pairing build",
      pretest: "pnpm --filter @knpkv/browser-pairing build",
      prebuild: "pnpm --filter @knpkv/browser-pairing build",
      precheck: "pnpm --filter @knpkv/browser-pairing build",
      check: "test -f package.json || tsc -p tsconfig.roles.json --noEmit"
    },
    browserPairingDependency
  ),
  ["packages/control-center/package.json: scripts.check must include the role-aware tsc check"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/control-center/package.json",
    {
      predev: "pnpm --filter @knpkv/browser-pairing build",
      pretest: "pnpm --filter @knpkv/browser-pairing build",
      prebuild: "pnpm --filter @knpkv/browser-pairing build",
      precheck: "pnpm --filter @knpkv/browser-pairing build",
      check: "test -f package.json && tsc -p tsconfig.roles.json --noEmit"
    },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(findCodeCommitWebLifecycleGaps("packages/other/package.json", {}, browserPairingDependency), [])

const controlCenterScripts = {
  predev: "pnpm --filter @knpkv/browser-pairing build",
  pretest: "pnpm --filter @knpkv/browser-pairing build",
  prebuild: "pnpm --filter @knpkv/browser-pairing build",
  precheck: "pnpm --filter @knpkv/browser-pairing build",
  check: "tsc -b tsconfig.json && tsc -p tsconfig.roles.json --noEmit"
}
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/control-center/package.json",
    controlCenterScripts,
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/control-center/package.json",
    { ...controlCenterScripts, predev: 'echo "pnpm --filter @knpkv/browser-pairing build"' },
    browserPairingDependency
  ),
  ["packages/control-center/package.json: scripts.predev must include a browser-pairing build"]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/control-center/package.json",
    { ...controlCenterScripts, check: "tsc -b tsconfig.json" },
    browserPairingDependency
  ),
  ["packages/control-center/package.json: scripts.check must include the role-aware tsc check"]
)
for (const invalidRoleCheck of [
  "exit 0 && tsc -p tsconfig.roles.json --noEmit",
  "alias tsc=:; tsc -b tsconfig.json && tsc -p tsconfig.roles.json --noEmit",
  "alias disable=set\ndisable -n\ntsc -p tsconfig.roles.json --noEmit",
  "set -- alias\n$1 tsc=:\ntsc -p tsconfig.roles.json --noEmit",
  "alias cache=hash\ncache -p /usr/bin/true tsc\ntsc -p tsconfig.roles.json --noEmit",
  "setup() { tsc() { :; }; }; setup; tsc -p tsconfig.roles.json --noEmit",
  "hash -p /usr/bin/true tsc; tsc -p tsconfig.roles.json --noEmit",
  "stop() { exit 0; }; builtin eval stop; tsc -p tsconfig.roles.json --noEmit",
  "enable -f ./fake-tsc.so tsc; tsc -p tsconfig.roles.json --noEmit",
  "alias invoke=builtin\ninvoke eval stop\ntsc -p tsconfig.roles.json --noEmit",
  "alias invoke=wrapper\nalias wrapper=builtin\ninvoke eval stop\ntsc -p tsconfig.roles.json --noEmit",
  "alias loader=enable\nloader -f ./fake-tsc.so tsc\ntsc -p tsconfig.roles.json --noEmit",
  "alias loader=wrapper\nalias wrapper=enable\nloader -f ./fake-tsc.so tsc\ntsc -p tsconfig.roles.json --noEmit",
  "alias options=set\noptions -n\ntsc -p tsconfig.roles.json --noEmit",
  "alias decl=export\ndecl PATH=/tmp/fake\ntsc -p tsconfig.roles.json --noEmit",
  "{ exit 0; }; tsc -p tsconfig.roles.json --noEmit",
  "set -e; { false; tsc -p tsconfig.roles.json --noEmit; }",
  "test -e package.json && exit 0; tsc -p tsconfig.roles.json --noEmit"
]) {
  assert.deepEqual(
    findCodeCommitWebLifecycleGaps(
      "packages/control-center/package.json",
      { ...controlCenterScripts, check: invalidRoleCheck },
      browserPairingDependency
    ),
    ["packages/control-center/package.json: scripts.check must include the role-aware tsc check"]
  )
}
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      prepack: "enable -f ./fake-pnpm.so pnpm; pnpm --filter @knpkv/browser-pairing build && tsc -b && vite build"
    },
    browserPairingDependency
  ),
  [lifecycleGap("prepack")]
)

for (const command of [
  `cleanup() { trap "exit 0" 0; }; { cleanup; }; pnpm --filter @knpkv/browser-pairing build`,
  "alias pnpm=:; test -e /definitely-not-present && unalias pnpm\npnpm --filter @knpkv/browser-pairing build",
  "{ command trap 'exit 0' 0; }; pnpm --filter @knpkv/browser-pairing build",
  String.raw`alias stop=exit
stop 0
pnpm --filter @knpkv/browser-pairing build`,
  "X=1 exit 0; pnpm --filter @knpkv/browser-pairing build",
  ">/dev/null exit 0; pnpm --filter @knpkv/browser-pairing build",
  "X=1 alias pnpm=:; pnpm --filter @knpkv/browser-pairing build",
  ">/dev/null alias pnpm=:; pnpm --filter @knpkv/browser-pairing build",
  "> /dev/null alias pnpm=:; pnpm --filter @knpkv/browser-pairing build",
  "readonly PATH=/tmp/fake; pnpm --filter @knpkv/browser-pairing build",
  "{ PATH=/tmp/fake; }; pnpm --filter @knpkv/browser-pairing build",
  "$(printf alias) pnpm=:; pnpm --filter @knpkv/browser-pairing build",
  "builtin=alias; ${builtin} pnpm=:; pnpm --filter @knpkv/browser-pairing build",
  "name=pnpm; alias ${name}=:; pnpm --filter @knpkv/browser-pairing build",
  "X=1 false=true alias pnpm=:; false && unalias pnpm; pnpm --filter @knpkv/browser-pairing build",
  "setup() { pnpm() { :; }; }; setup; pnpm --filter @knpkv/browser-pairing build",
  String.raw`pnpm \
() { :; }; pnpm --filter @knpkv/browser-pairing build`,
  String.raw`\
  command alias pnpm=:
pnpm --filter @knpkv/browser-pairing build`
]) {
  assert.deepEqual(
    findCodeCommitWebLifecycleGaps(
      "packages/codecommit-web/package.json",
      { ...codeCommitWebScripts, predev: command },
      browserPairingDependency
    ),
    [lifecycleGap("predev")]
  )
}
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev:
        "mkdir -p /tmp/fake; ln -sf /usr/bin/true /tmp/fake/pnpm; PATH=/tmp/fake; pnpm --filter @knpkv/browser-pairing build"
    },
    browserPairingDependency
  ),
  [lifecycleGap("predev")]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "FOO=1; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, predev: "prepare() { (exit 0); }; prepare; pnpm --filter @knpkv/browser-pairing build" },
    browserPairingDependency
  ),
  []
)

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
