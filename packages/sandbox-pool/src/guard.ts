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
