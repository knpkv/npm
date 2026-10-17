import { describe, expect, it } from "@effect/vitest"
import { protectedListed, wouldRemove } from "../src/index.js"
import { dryRunListedSamlProvider } from "./dry-run-fixture.js"
import { contract } from "./fixtures.js"

/** aws-nuke 3.68.3 prints one plain line per resource, as in the live fixture. */
const line = (body: string) => `${body} - would remove`
const plain = (body: string) => `global - ${body} - would remove`

describe("protected-resource guard", () => {
  it("the live dry run that listed the Identity Center SAML provider is caught", () => {
    expect(wouldRemove(dryRunListedSamlProvider)).toHaveLength(24)
    const hits = protectedListed(contract, dryRunListedSamlProvider)
    expect(hits.map((hit) => hit.protectedClass)).toEqual(["Identity Center SAML provider"])
    expect(hits[0]?.line).toMatch(/AWSSSO_0123456789abcdef_DO_NOT_DELETE/)
  })

  it("each protected class is caught by name, ARN, path or type", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        "Identity Center SAML provider",
        plain("IAMSAMLProvider - arn:aws:iam::1:saml-provider/AWSSSO_x_DO_NOT_DELETE - [ARN: \"…\"]")
      ],
      ["Identity Center role", plain("IAMRole - AWSReservedSSO_PoolDeveloper_84e6 - [Path: \"/aws-reserved/\"]")],
      ["Identity Center role", plain("IAMRolePolicy - AWSReservedSSO_PoolDeveloper_84e6 -> AwsSSOInlinePolicy - []")],
      ["organization access role", plain("IAMRole - PoolAccessRole - []")],
      ["organization access role", plain("IAMRolePolicyAttachment - PoolAccessRole -> AdministratorAccess - []")],
      [
        "service-linked role",
        plain("IAMRole - AWSServiceRoleForSSO - [Path: \"/aws-service-role/sso.amazonaws.com/\"]")
      ],
      ["permissions boundary", plain("IAMPolicy - arn:aws:iam::1:policy/pool/PoolBoundary - []")],
      ["budget action", plain("IAMRole - example-pool-budget-action - []")],
      ["budget action", plain("OrganizationsPolicy - PoolDenyAll - []")],
      ["account alias", plain("IAMAccountAlias - example-pool-sandbox-a - []")]
    ]
    for (const [expected, listed] of cases) {
      expect(protectedListed(contract, listed).map((hit) => hit.protectedClass), listed).toEqual([expected])
    }
  })

  it("ordinary sandbox resources pass, even sharing the alias prefix; filtered lines are not removals", () => {
    const output = [
      line("eu-central-1 - EC2VPC - vpc-1 - [IsDefault: \"true\"]"),
      line("global - IAMRole - pool-build - [Path: \"/pool/\"]"),
      line("eu-central-1 - CodeCommitRepository - demo - []"),
      line("eu-central-1 - S3Bucket - s3://example-pool-scratch - []"),
      "global - IAMRole - PoolAccessRole - [Path: \"/\"] - filtered by config",
      "global - IAMRole - AWSReservedSSO_X - [] - filtered: cannot delete SSO roles"
    ].join("\n")
    expect(wouldRemove(output)).toHaveLength(4)
    expect(protectedListed(contract, output)).toEqual([])
  })

  it("reads removal lines through terminal colour codes and carriage returns", () => {
    const esc = String.fromCharCode(27)
    const coloured = dryRunListedSamlProvider
      .split("\n")
      .map((row) => `${esc}[36m${row.replace(" - would remove", ` - ${esc}[32mwould remove${esc}[0m`)}\r`)
      .join("\n")
    expect(wouldRemove(coloured)).toHaveLength(24)
    expect(protectedListed(contract, coloured).map((hit) => hit.protectedClass)).toEqual([
      "Identity Center SAML provider"
    ])
  })
})
