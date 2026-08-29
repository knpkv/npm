/**
 * Unit tests for recognising a CodeCommit remote URL.
 *
 * This is the one part of `pr open` that can be wrong with no AWS call and no
 * spawner involved, so every remote form CodeCommit hands out is asserted here
 * rather than through the command that consumes it.
 */
import { describe, expect, it } from "@effect/vitest"
import { parseCodeCommitRemote, redactRemoteUserInfo } from "../src/CodeCommitRemote.js"

describe("parseCodeCommitRemote", () => {
  it("reads the region and repository out of every remote form CodeCommit hands out", () => {
    const cases: ReadonlyArray<readonly [string, { region: string | null; repositoryName: string }]> = [
      [
        "https://git-codecommit.eu-central-1.amazonaws.com/v1/repos/application-monitoring",
        { region: "eu-central-1", repositoryName: "application-monitoring" }
      ],
      // SSH carries the region in the same host position as HTTPS.
      [
        "ssh://APKAEXAMPLE@git-codecommit.us-east-1.amazonaws.com/v1/repos/payments-api",
        { region: "us-east-1", repositoryName: "payments-api" }
      ],
      // FIPS and China endpoints are the same URL with a decorated host.
      [
        "https://git-codecommit-fips.us-gov-west-1.amazonaws.com/v1/repos/payments-api",
        { region: "us-gov-west-1", repositoryName: "payments-api" }
      ],
      [
        "https://git-codecommit.cn-north-1.amazonaws.com.cn/v1/repos/payments-api",
        { region: "cn-north-1", repositoryName: "payments-api" }
      ],
      // git-remote-codecommit: the authority is the repository, not a host.
      [
        "codecommit::eu-central-1://core-code-awscodecommitpoweruser@identity",
        { region: "eu-central-1", repositoryName: "identity" }
      ],
      // The region-less form names no region, so the scan cannot be narrowed by one.
      ["codecommit://core-code@identity", { region: null, repositoryName: "identity" }],
      ["codecommit://identity", { region: null, repositoryName: "identity" }]
    ]

    for (const [url, expected] of cases) {
      expect(parseCodeCommitRemote(url)).toEqual(expected)
    }
  })

  it("strips the .git suffix and trailing slashes a clone may carry", () => {
    expect(parseCodeCommitRemote("https://git-codecommit.eu-central-1.amazonaws.com/v1/repos/identity.git"))
      .toEqual({ region: "eu-central-1", repositoryName: "identity" })
    expect(parseCodeCommitRemote("  https://git-codecommit.eu-central-1.amazonaws.com/v1/repos/identity/  "))
      .toEqual({ region: "eu-central-1", repositoryName: "identity" })
  })

  it("declines a remote no CodeCommit account can hold", () => {
    // Answering null rather than guessing is what keeps a four-account scan from
    // running for a repository that does not live in CodeCommit at all.
    const declined = [
      "https://dev.azure.com/ockto/Ockto/_git/MessageWorker",
      "git@github.com:Effect-TS/effect.git",
      "https://git-codecommit.eu-central-1.amazonaws.com/v1/repos/",
      "https://git-codecommit.eu-central-1.amazonaws.com/v2/repos/identity",
      ""
    ]

    for (const url of declined) {
      expect(parseCodeCommitRemote(url)).toBeNull()
    }
  })
})

describe("redactRemoteUserInfo", () => {
  it("blanks a credential carried in the remote before it is echoed back", () => {
    // The rejection path prints the remote so the caller can see what was found,
    // and a token in the userinfo would go to the terminal and the popup with it.
    expect(redactRemoteUserInfo("https://alice:ghp_secret@github.com/org/repo.git"))
      .toBe("https://***@github.com/org/repo.git")
    expect(redactRemoteUserInfo("https://ockto@dev.azure.com/ockto/Ockto/_git/MessageWorker"))
      .toBe("https://***@dev.azure.com/ockto/Ockto/_git/MessageWorker")
  })

  it("leaves a remote that carries no credential exactly as it was", () => {
    // scp-like syntax has no `//`, and its userinfo is a login name, not a secret.
    for (
      const url of [
        "git@github.com:Effect-TS/effect.git",
        "https://dev.azure.com/ockto/Ockto/_git/MessageWorker",
        "codecommit::eu-central-1://core-code@identity",
        ""
      ]
    ) {
      expect(redactRemoteUserInfo(url)).toBe(url)
    }
  })
})
