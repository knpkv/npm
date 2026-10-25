import { accountAlias, type PoolContract } from "./pool.js"

/**
 * Second layer under the aws-nuke filters. A reset checks the dry run's
 * "would remove" list against these classes before any live run; a match
 * aborts and quarantines, whatever the nuke config says. A filter bug then
 * cannot delete what the organization or Identity Center owns.
 *
 * A class matches when the whole aws-nuke line (region, type, identifier and
 * properties) contains any of its markers, so a resource is caught by name,
 * ARN, path or type. Markers are plain substrings: contract values never need
 * escaping.
 */
export interface ProtectedClass {
  readonly name: string
  readonly markers: ReadonlyArray<string>
}

/** The protected classes for one pool; the organization-named ones come from its contract. */
export const protectedClasses = (contract: PoolContract): ReadonlyArray<ProtectedClass> => [
  { name: "Identity Center SAML provider", markers: ["saml-provider/AWSSSO_"] },
  { name: "Identity Center role", markers: ["AWSReservedSSO_"] },
  { name: "organization access role", markers: [contract.accountAccessRole] },
  { name: "service-linked role", markers: ["/aws-service-role/", "AWSServiceRoleFor"] },
  { name: "permissions boundary", markers: [contract.boundaryName] },
  { name: "budget action", markers: [contract.budgetActionRole, contract.denyAllPolicy] },
  {
    name: "account alias",
    markers: ["IAMAccountAlias", ...contract.accounts.map(({ name }) => accountAlias(contract, name))]
  }
]

export interface ProtectedHit {
  readonly protectedClass: string
  readonly line: string
}

/** Terminal colour codes: ESC, `[`, parameters, `m`. */
const terminalStyle = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")

/** One output line without terminal colour codes or a trailing carriage return. */
const plainLine = (line: string): string => line.replace(terminalStyle, "").trim()

/**
 * The last lines of an aws-nuke run as the run log keeps them: uncoloured, blank lines dropped, at most `lines`
 * lines of at most 300 characters. They name the pool account's resources, so they are as private as the account.
 */
export const outputTail = (output: string, lines = 40): ReadonlyArray<string> =>
  output.split("\n").map(plainLine).filter((line) => line.length > 0).slice(-lines)
    .map((line) => Array.from(line).slice(0, 300).join(""))

/**
 * Error-level log lines: a resource type aws-nuke could not list. The run can
 * still exit 0 with a clean summary, so a scan with one is incomplete. Fails
 * closed on a `level=error|fatal|panic` field anywhere in the line, whatever
 * prefixes it, but not inside a quoted value or a resource's `[...]`
 * properties, so a resource whose name or properties say "level=error" is not
 * one. An unquoted identifier can still contain `=` (IAM names allow it), so a
 * resource named `level=error` quarantines a clean account: the safe direction.
 * Colours are off (see `nukeArgs` in reset.ts); JSON logs are matched too.
 *
 * One warning also means a short scan: libnuke stops enqueueing a resource type
 * when its scan queue fills, and counts only what it kept. That log line, at any
 * level, is incomplete discovery too; other warnings are not. The wording is
 * libnuke 1.3.0's, as shipped in aws-nuke 3.68.3: re-check it on an aws-nuke bump.
 */
const logLevel = /(?:^|\s)level=(?:error|fatal|panic)(?:\s|$)|"level":"(?:error|fatal|panic)"/
const anyLevel = /(?:^|\s)level=\w+(?:\s|$)|"level":"\w+"/
const queueFull = "not all resources will be enqueued"

/** The line without quoted values or bracketed properties, which resources and messages control. */
const logFields = (line: string): string => line.replace(/\[[^\]]*\]/g, " ").replace(/"(?:[^"\\]|\\.)*"/g, "\"\"")

/**
 * A listing failure that is not a hole in the scan: `types` fail in `region` (every region when null) with an
 * `error=` matching `cause`, and that failure means nothing of the type can exist there. Any other failure of the
 * same type, or the same failure elsewhere, still counts.
 */
interface ExpectedFailure {
  readonly region: string | null
  readonly types: ReadonlySet<string>
  readonly cause: RegExp
}

const expectedFailures: ReadonlyArray<ExpectedFailure> = [
  // No Q Business endpoint in eu-central-1; us-east-1 has one and is still scanned.
  {
    region: "eu-central-1",
    types: new Set([
      "QBusinessApplication",
      "QBusinessDataSource",
      "QBusinessIndex",
      "QBusinessPlugin",
      "QBusinessRetriever",
      "QBusinessWebExperience"
    ]),
    cause: /no such host/
  },
  // eu-central-1 has no Bedrock model customization API; us-east-1 does.
  { region: "eu-central-1", types: new Set(["BedrockModelCustomizationJob"]), cause: /UnknownOperationException/ },
  // Without a Shield Advanced subscription there are no protections. The organization does not deny subscribing,
  // so the types stay in the scan and only this failure is expected.
  {
    region: null,
    types: new Set(["ShieldProtection", "ShieldProtectionGroup"]),
    cause: /ResourceNotFoundException: The subscription does not exist/
  }
]

/** logfmt `key=value` pairs; a quoted value is consumed whole, so text inside it never reads as another key. */
const logfmtPair = /(?:^|\s)(\w+)=("(?:[^"\\]|\\.)*"|\S*)/g

/**
 * The line with every unquoted bracketed segment blanked out, through its matching outer bracket however
 * deeply brackets nest; quoted values are kept whole, brackets in them included. An unclosed bracket blanks
 * the rest of the line, so text inside one never reads as a field.
 */
const topLevel = (line: string): string => {
  let out = ""
  let depth = 0
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? ""
    if (quoted) {
      out += depth === 0 ? char : " "
      if (char === "\\") {
        index++
        out += depth === 0 ? (line[index] ?? "") : " "
      } else if (char === "\"") quoted = false
    } else if (char === "\"") {
      quoted = true
      out += depth === 0 ? char : " "
    } else if (char === "[") {
      depth++
      out += " "
    } else if (char === "]" && depth > 0) {
      depth--
      out += " "
    } else out += depth === 0 ? char : " "
  }
  return out
}

/**
 * The line's top-level logfmt fields, quoted values unquoted, each key with every value it was given. Text in
 * unquoted brackets is not read. Resource listings without these have none.
 */
const logfmtFields = (line: string): ReadonlyMap<string, ReadonlyArray<string>> => {
  const top = topLevel(line)
  const fields = new Map<string, Array<string>>()
  for (const [, key = "", value = ""] of top.matchAll(logfmtPair)) {
    fields.set(key, [...(fields.get(key) ?? []), value.startsWith("\"") ? value.slice(1, -1) : value])
  }
  return fields
}

/** The one value of `key`; a key the line names twice is ambiguous, so it has none. */
const only = (fields: ReadonlyMap<string, ReadonlyArray<string>>, key: string): string | undefined => {
  const values = fields.get(key)
  return values?.length === 1 ? values[0] : undefined
}

/**
 * Whether a log line is one of `expectedFailures`, judged by its own owner=, resource_type= and error= fields, each
 * named exactly once.
 */
const isExpectedFailure = (line: string): boolean => {
  const fields = logfmtFields(line)
  const region = only(fields, "owner")
  const resourceType = only(fields, "resource_type")
  const error = only(fields, "error")
  if (region === undefined || resourceType === undefined || error === undefined) return false
  return expectedFailures.some((expected) =>
    (expected.region === null || expected.region === region) && expected.types.has(resourceType) &&
    expected.cause.test(error)
  )
}

/** Every line of a run that reports failed discovery, colour codes removed. Expected failures are not. */
export const discoveryFailures = (output: string): ReadonlyArray<string> =>
  output.split("\n").map(plainLine).filter((line) => {
    const fields = line.startsWith("{") ? line : logFields(line)
    if (!line.startsWith("{") && isExpectedFailure(line)) return false
    return logLevel.test(fields) || (anyLevel.test(fields) && line.includes(queueFull))
  })

/** The resources an aws-nuke run lists for removal, one line each, colour codes removed. */
export const wouldRemove = (output: string): ReadonlyArray<string> =>
  output
    .split("\n")
    .map(plainLine)
    .filter((line) => line.endsWith("- would remove"))

/** Every protected resource in a dry run's removal list. Empty means the live run may proceed. */
export const protectedListed = (contract: PoolContract, output: string): ReadonlyArray<ProtectedHit> => {
  const classes = protectedClasses(contract)
  return wouldRemove(output).flatMap((line) => {
    const hit = classes.find(({ markers }) => markers.some((marker) => line.includes(marker)))
    return hit === undefined ? [] : [{ protectedClass: hit.name, line }]
  })
}
