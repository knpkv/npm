import { readinessPortfolio } from "./readinessPortfolio.js"
import type { ProviderScenario } from "./transport.js"

const observedAt = "2026-07-14T11:55:00.000Z"

/** Provider-shaped Jira responses are decoded and normalized by the production adapter. */
export const jiraResponse = (url: URL, scenario: ProviderScenario, connectionLabel: string, sixVerdicts = false) => {
  const path = url.pathname
  const second = connectionLabel === "jira-b"
  const project = {
    id: second ? "20001" : "10001",
    key: second ? "CAT" : "FIX",
    name: second ? "Fixture catalogue" : "Fixture service"
  }
  if (path === "/rest/api/3/myself") {
    return { accountId: "fixture-owner", displayName: "Release Owner", active: true, timeZone: "UTC" }
  }
  if (path === "/rest/api/3/serverInfo") {
    return { baseUrl: "https://fixture.atlassian.net", serverTitle: "Fixture site" }
  }
  if (/^\/rest\/api\/3\/project\/[^/]+$/u.test(path)) return project
  if (/^\/rest\/api\/3\/issue\/[^/]+\/comment$/u.test(path)) {
    return { startAt: 0, maxResults: 50, total: 0, comments: [] }
  }
  if (/^\/rest\/api\/3\/issue\/[^/]+\/changelog$/u.test(path)) {
    return { startAt: 0, maxResults: 50, total: 0, isLast: true, values: [] }
  }
  if (path === "/rest/api/3/search/jql") {
    if (sixVerdicts) {
      return {
        isLast: true,
        issues: readinessPortfolio.map((release) => ({
          id: release.issueId,
          key: release.issueKey,
          fields: {
            summary: `Fixture ${release.verdict} delivery`,
            updated: observedAt,
            created: observedAt,
            project,
            status: { id: "1", name: "Done", statusCategory: { id: 3, key: "done", name: "Done" } },
            assignee: { accountId: "fixture-owner", displayName: "Release Owner", active: true },
            fixVersions: [{ id: release.versionId, name: release.version, released: false, archived: false }],
            labels: [],
            components: [],
            subtasks: []
          }
        }))
      }
    }
    return {
      isLast: scenario !== "paginated" || url.searchParams.has("nextPageToken"),
      nextPageToken: scenario === "paginated" && !url.searchParams.has("nextPageToken")
        ? "fixture-next-page"
        : undefined,
      issues: [{
        id: second ? "20010" : "10010",
        key: second ? "CAT-1" : "FIX-1",
        fields: {
          summary: connectionLabel === "jira-a" ? "Fixture checkout change" : "Fixture catalogue change",
          updated: observedAt,
          created: observedAt,
          project,
          status: { id: "1", name: "Done", statusCategory: { id: 3, key: "done", name: "Done" } },
          assignee: { accountId: "fixture-owner", displayName: "Release Owner", active: true },
          fixVersions: [{
            id: second ? "20020" : "10020",
            name: second ? "2.0.0" : "1.0.0",
            released: false,
            archived: false
          }],
          labels: [],
          components: [],
          subtasks: []
        }
      }]
    }
  }
  if (/^\/rest\/api\/3\/project\/[^/]+\/version(?:s)?$/u.test(path)) {
    return { isLast: true, total: 1, values: [{ id: "10020", name: "1.0.0", projectId: 10001 }] }
  }
  return undefined
}
