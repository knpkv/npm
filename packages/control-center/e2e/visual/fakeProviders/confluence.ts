import type { ConfluenceV1Api } from "@knpkv/confluence-api-client"

import { readinessPortfolio } from "./readinessPortfolio.js"
import type { ProviderScenario } from "./transport.js"

const observedAt = "2026-07-14T11:55:00.000Z"
const version = {
  number: 1,
  createdAt: observedAt,
  authorId: "fixture-owner",
  minorEdit: false,
  message: "Fixture release notes"
}
const page = {
  id: "30001",
  title: "Fixture release 1.0.0 checklist",
  status: "current",
  spaceId: "40001",
  authorId: "fixture-owner",
  ownerId: "fixture-owner",
  createdAt: observedAt,
  version,
  body: {
    atlas_doc_format: {
      representation: "atlas_doc_format",
      value: JSON.stringify({
        version: 1,
        type: "doc",
        content: [{
          type: "taskList",
          attrs: { localId: "fixture-tasks" },
          content: [
            {
              type: "taskItem",
              attrs: { localId: "fixture-task", state: "TODO" },
              content: [{ type: "text", text: "Release Owner approves release 1.0.0" }]
            }
          ]
        }]
      })
    }
  },
  _links: { webui: "/spaces/FIX/pages/30001" }
}

/** Raw Atlassian shapes pass through the real page client, ADF converter and normalizer. */
export const confluenceResponse = (url: URL, scenario: ProviderScenario, omitBody: boolean, sixVerdicts = false) => {
  const path = url.pathname
  if (path === "/wiki/rest/api/user/current") {
    return { accountId: "fixture-owner", displayName: "Release Owner", type: "known" }
  }
  if (path === "/wiki/rest/api/settings/systemInfo") {
    return {
      baseUrl: "https://fixture.atlassian.net",
      cloudId: "fixture-site",
      commitHash: "fixture-commit",
      siteTitle: "Fixture site"
    } satisfies ConfluenceV1Api.GetSystemInfo200
  }
  const pages = sixVerdicts ?
    readinessPortfolio.map((release) => ({
      ...page,
      id: release.pageId,
      title: `Release ${release.version} runbook`,
      labels: {
        results: release.exactRunbook
          ? [{ id: `fixture-${release.pageId}`, prefix: "global", name: release.version }]
          : [],
        meta: { hasMore: false }
      },
      body: {
        atlas_doc_format: {
          representation: "atlas_doc_format",
          value: JSON.stringify({
            version: 1,
            type: "doc",
            content: [{
              type: "taskList",
              attrs: { localId: `fixture-tasks-${release.pageId}` },
              content: [{
                type: "taskItem",
                attrs: { localId: `fixture-task-${release.pageId}`, state: "DONE" },
                content: [{ type: "text", text: "Release checklist complete" }]
              }]
            }]
          })
        }
      },
      _links: { webui: `/spaces/FIX/pages/${release.pageId}` }
    })) :
    [{ ...page, labels: { results: [], meta: { hasMore: false } } }]
  const pageId = /^\/wiki\/api\/v2\/pages\/([^/]+)/u.exec(path)?.[1]
  const selected = pageId === undefined ? pages[0] : pages.find(({ id }) => id === pageId)
  if (pageId !== undefined && selected === undefined) return undefined
  const wirePage = { ...selected, body: omitBody ? undefined : selected?.body }
  if (/^\/wiki\/api\/v2\/pages\/[^/]+$/u.test(path)) return wirePage
  if (/^\/wiki\/api\/v2\/spaces\/[^/]+\/pages$/u.test(path)) {
    return {
      results: url.searchParams.has("cursor")
        ? []
        : pages.map((page) => ({ ...page, body: omitBody ? undefined : page.body })),
      _links: {
        next: scenario === "paginated" && !url.searchParams.has("cursor")
          ? "/wiki/api/v2/spaces/40001/pages?cursor=fixture-next-page"
          : undefined
      }
    }
  }
  if (/^\/wiki\/api\/v2\/pages\/[^/]+\/versions$/u.test(path)) return { results: [version], _links: {} }
  if (/^\/wiki\/api\/v2\/pages\/[^/]+\/labels$/u.test(path)) return selected?.labels
  if (/^\/wiki\/api\/v2\/pages\/[^/]+\/attachments$/u.test(path)) return { results: [], _links: {} }
  if (/^\/wiki\/rest\/api\/content\/[^/]+\/notification\/child-created$/u.test(path)) {
    return { results: [], start: 0, limit: 50, size: 0 }
  }
  if (path === "/wiki/api/v2/users-bulk") {
    return {
      results: [{
        accountId: "fixture-owner",
        displayName: "Release Owner",
        accountStatus: "active",
        isExternalCollaborator: false
      }]
    }
  }
  return undefined
}
