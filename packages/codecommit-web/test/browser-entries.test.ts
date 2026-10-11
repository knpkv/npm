import { expect, it } from "@effect/vitest"
import { isBuiltin } from "node:module"
import { build, type Plugin } from "vite"
import viewsConfig from "../vite.views.config.js"

const isNodeBuiltin: (specifier: string) => boolean = isBuiltin
const isApplicationRuntime = (id: string): boolean =>
  /(?:^|\/)client\/atoms\//.test(id) || /(?:^|\/)ownerSession\.ts(?:\?|$)/.test(id)

/** Views must bundle for browsers without importing application atoms or the owner-session runtime. */
it("bundles ./views without Node built-ins, application atoms or the owner-session runtime", async () => {
  const moduleIds = new Set<string>()
  const browserBoundary: Plugin = {
    name: "reject-server-runtime",
    enforce: "pre",
    resolveId(path: string) {
      if (path.startsWith("node:") || isNodeBuiltin(path)) {
        this.error(`Browser entry imports Node built-in "${path}"`)
      }
      // Styles are verified by the real library build; this guard needs no built peer CSS.
      if (path.endsWith(".css")) return "\0browser-entry-styles"
      return null
    },
    load(id: string) {
      return id === "\0browser-entry-styles" ? "export default {}" : null
    },
    moduleParsed(info) {
      moduleIds.add(info.id)
      if (isApplicationRuntime(info.id)) {
        this.error(`Browser entry imports application runtime "${info.id}"`)
      }
    }
  }

  const result = await build({
    ...viewsConfig,
    configFile: false,
    root: new URL("..", import.meta.url).pathname,
    plugins: [...(viewsConfig.plugins ?? []), browserBoundary],
    logLevel: "silent",
    build: {
      ...viewsConfig.build,
      write: false
    }
  })
  const exportedNames = new Set<string>()
  const collectExports = (output: Awaited<ReturnType<typeof build>>): void => {
    if (Array.isArray(output)) {
      for (const item of output) collectExports(item)
    } else if ("output" in output) {
      for (const chunk of output.output) {
        if (chunk.type === "chunk" && chunk.isEntry) {
          for (const name of chunk.exports) exportedNames.add(name)
        }
      }
    }
  }
  collectExports(result)
  for (
    const name of [
      "PRListView",
      "SearchBarView",
      "FilterSidebarView",
      "RecentActivityView",
      "PRDetailView",
      "PRDetailHeaderView",
      "PRRevisionView",
      "PRDescriptionView",
      "PRCommentsView",
      "PRLifecycleView",
      "PRApprovalsView",
      "ApproversCard",
      "PRHealthBreakdownView",
      "PRRequirementDialogsView",
      "PRFilesDiffView"
    ]
  ) {
    expect(exportedNames.has(name)).toBe(true)
  }
  expect(moduleIds.size).toBeGreaterThan(0)
  expect([...moduleIds].filter(isApplicationRuntime)).toEqual([])
  expect(
    [...moduleIds].filter((id) =>
      /\/components\/(?:pr-list|search-bar|filter-sidebar|pr-detail|pr-comments|pr-lifecycle|pr-review-workspace)\.tsx(?:\?|$)/
        .test(id)
    )
  ).toEqual([])
  for (
    const module of [
      "pr-list-view",
      "search-bar-view",
      "filter-sidebar-view",
      "recent-activity-view",
      "pr-detail-view",
      "pr-detail-header-view",
      "pr-revision-view",
      "pr-description-view",
      "pr-comments-view",
      "pr-lifecycle-view",
      "pr-approvals-view",
      "pr-health-breakdown-view",
      "pr-requirement-dialogs-view",
      "pr-files-diff-view"
    ]
  ) {
    expect([...moduleIds].some((id) => id.endsWith(`/components/${module}.tsx`))).toBe(true)
  }
})
