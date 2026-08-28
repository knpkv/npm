import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

import { decodeCodeCommitMockEndpoint, routeAwsRequestToCodeCommitMock } from "../src/MockTransport.js"

describe("CodeCommit mock transport", () => {
  it("routes only CodeCommit and STS requests to a loopback mock", () => {
    const endpoint = decodeCodeCommitMockEndpoint("http://127.0.0.1:4599")
    const codeCommit = routeAwsRequestToCodeCommitMock(
      HttpClientRequest.post("https://codecommit.eu-west-1.amazonaws.com/").pipe(
        HttpClientRequest.setUrlParam("trace", "one"),
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

  it("rejects non-loopback and path-bearing endpoints", () => {
    expect(() => decodeCodeCommitMockEndpoint("https://mock.example.test")).toThrow()
    expect(() => decodeCodeCommitMockEndpoint("http://127.0.0.1:4599/base")).toThrow()
    expect(decodeCodeCommitMockEndpoint("http://[::1]:4599").origin).toBe("http://[::1]:4599")
  })
})
