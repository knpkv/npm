import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

import { decodeCodeCommitMockEndpoint, routeAwsRequestToCodeCommitMock } from "../src/MockTransport.js"

describe("CodeCommit mock transport", () => {
  it("routes only CodeCommit and STS requests to a loopback mock", () => {
    const endpoint = decodeCodeCommitMockEndpoint("http://127.0.0.1:4599")
    const codeCommit = routeAwsRequestToCodeCommitMock(
      HttpClientRequest.post("https://codecommit.eu-west-1.amazonaws.com/?trace=one").pipe(
        HttpClientRequest.setHeader("authorization", "real-signed-credential"),
        HttpClientRequest.setHeader("x-amz-security-token", "real-session-token")
      ),
      endpoint
    )
    const sts = routeAwsRequestToCodeCommitMock(
      HttpClientRequest.post("https://sts.eu-west-1.amazonaws.com/"),
      endpoint
    )
    const unrelated = routeAwsRequestToCodeCommitMock(
      HttpClientRequest.get("https://api.atlassian.com/ex/jira/site"),
      endpoint
    )
    const codePipeline = routeAwsRequestToCodeCommitMock(
      HttpClientRequest.post("https://codepipeline.eu-west-1.amazonaws.com/"),
      endpoint
    )

    expect(Option.getOrThrow(HttpClientRequest.toUrl(codeCommit)).href)
      .toBe("http://127.0.0.1:4599/?trace=one")
    expect(codeCommit.headers.authorization).toBeUndefined()
    expect(codeCommit.headers["x-amz-security-token"]).toBeUndefined()
    expect(sts.url).toBe("http://127.0.0.1:4599/")
    expect(unrelated.url).toBe("https://api.atlassian.com/ex/jira/site")
    expect(codePipeline.url).toBe("https://codepipeline.eu-west-1.amazonaws.com/")
  })

  it("keeps operation parameters but strips presigned SigV4 credentials", () => {
    const endpoint = decodeCodeCommitMockEndpoint("http://127.0.0.1:4599")
    const routed = routeAwsRequestToCodeCommitMock(
      HttpClientRequest.get(
        "https://sts.eu-west-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15" +
          "&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=real-access-key" +
          "&X-Amz-Date=20260829T000000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host" +
          "&X-Amz-Signature=real-signature&X-Amz-Security-Token=real-session-token"
      ),
      endpoint
    )

    expect(Option.getOrThrow(HttpClientRequest.toUrl(routed)).href)
      .toBe("http://127.0.0.1:4599/?Action=GetCallerIdentity&Version=2011-06-15")
  })

  it("rejects non-loopback and path-bearing endpoints", () => {
    expect(() => decodeCodeCommitMockEndpoint("https://mock.example.test")).toThrow()
    expect(() => decodeCodeCommitMockEndpoint("http://127.0.0.1:4599/base")).toThrow()
    expect(decodeCodeCommitMockEndpoint("http://[::1]:4599").origin).toBe("http://[::1]:4599")
  })
})
