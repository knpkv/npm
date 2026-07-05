import { describe, expect, it } from "@effect/vitest"
import { JiraApiClient } from "@knpkv/jira-api-client"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { IssueService, layer as IssueServiceLayer, SiteUrl } from "../src/IssueService.js"

const JiraClientLayer = Layer.succeed(
  JiraApiClient,
  JiraApiClient.of({
    v3: {
      client: {
        GET: (path: string) =>
          path === "/rest/api/3/issue/{issueIdOrKey}"
            ? Promise.resolve({
              data: {
                id: "10000",
                key: "PROJ-123",
                fields: {
                  attachment: [{
                    id: "30001",
                    filename: "diagram.svg",
                    content: "https://example.atlassian.net/rest/api/3/attachment/content/30001",
                    mimeType: "image/svg+xml",
                    size: 448
                  }, {
                    id: "30002",
                    filename: "unknown.bin",
                    content: "https://example.atlassian.net/rest/api/3/attachment/content/30002",
                    size: 99
                  }],
                  components: [],
                  created: "2026-01-01T00:00:00.000Z",
                  description: "",
                  fixVersions: [],
                  issuetype: { name: "Task" },
                  labels: [],
                  status: { name: "Done" },
                  summary: "Sample issue",
                  updated: "2026-01-01T00:00:00.000Z"
                },
                renderedFields: {}
              },
              response: { ok: true, status: 200 }
            })
            : Promise.resolve({ data: {}, response: { ok: false, status: 404 } })
      }
    }
  } as never)
)

const TestLayer = IssueServiceLayer.pipe(
  Layer.provide(JiraClientLayer),
  Layer.provide(Layer.succeed(SiteUrl, "https://example.atlassian.net"))
)

describe("IssueService", () => {
  it.effect("keeps mimeType as a backwards-compatible attachment alias", () =>
    Effect.gen(function*() {
      const service = yield* IssueService
      const issue = yield* service.getByKey("PROJ-123")

      expect(issue.attachments).toEqual([{
        id: "30001",
        filename: "diagram.svg",
        url: "https://example.atlassian.net/rest/api/3/attachment/content/30001",
        mediaType: "image/svg+xml",
        mimeType: "image/svg+xml",
        size: 448
      }, {
        id: "30002",
        filename: "unknown.bin",
        url: "https://example.atlassian.net/rest/api/3/attachment/content/30002",
        mediaType: null,
        mimeType: "",
        size: 99
      }])
    }).pipe(Effect.provide(TestLayer)))
})
