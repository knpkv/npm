import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import { isBuiltin } from "node:module"
import { build, type Plugin } from "vite"
import viewsConfig from "../vite.views.config.js"

const viewModules = new Set([
  "BrowserSessionStatusView.tsx",
  "formatTime.ts",
  "portfolio/PortfolioOverviewView.tsx",
  "portfolio/portfolioFilters.ts",
  "portfolio/presentPortfolio.ts",
  "releases/RelationshipRepairPanelView.tsx",
  "releases/ReleaseEvidence.tsx",
  "services/ConnectionSynchronizationView.tsx",
  "services/ConnectionTestEvidence.tsx",
  "services/connectionState.ts",
  "services/serviceOnboarding.ts",
  "services/syncPresentation.ts",
  "settings/SettingsForm.tsx",
  "settings/ReleaseTargetsEditor.tsx",
  "settings/releaseTargetErrorMessage.ts",
  "entities/WorkspaceIssueDetails.tsx",
  "entities/WorkspacePipelineExecutionDetails.tsx",
  "entities/WorkspaceClockifyTimeEntryDetails.tsx",
  "entities/WorkspaceRichText.tsx",
  "entities/ReviewSuggestionPresentation.tsx",
  "entities/ReviewSuggestionOverview.tsx",
  "entities/ReviewSuggestionRevisionHistory.tsx",
  "entities/ReviewSuggestionRevisionDialog.tsx",
  "entities/ReviewSuggestionPublicationSurface.tsx"
])

const expectedViews = [
  "WorkspaceIssueDetails",
  "WorkspacePipelineExecutionDetails",
  "WorkspaceClockifyTimeEntryDetails",
  "WorkspaceRichText",
  "ConnectionTestEvidence",
  "ReleaseTargetsEditor",
  "ReviewSuggestionCard",
  "ReviewNotes",
  "ReviewSuggestionOverview",
  "ReviewSuggestionRevisionHistory",
  "ReviewSuggestionRevisionDialog",
  "ReviewSuggestionPublicationSurface",
  "PortfolioOverviewView",
  "RelationshipRepairPanelView",
  "SettingsForm",
  "ReleaseEvidence",
  "BrowserSessionStatusView",
  "ConnectionSynchronizationView"
]

const browserBoundary = (): Plugin => ({
  name: "views-browser-boundary",
  enforce: "pre",
  resolveId(specifier: string) {
    if (specifier.startsWith("node:") || isBuiltin(specifier)) {
      this.error(`Browser view imports Node built-in "${specifier}"`)
    }
    // The actual library build verifies CSS; this guard needs no built peer styles.
    if (specifier.endsWith(".css")) return "\0view-styles"
    return null
  },
  load(id: string) {
    return id === "\0view-styles" ? "export default {}" : null
  },
  moduleParsed(info) {
    for (const imported of [...info.importedIds, ...info.dynamicallyImportedIds]) {
      if (imported === "@knpkv/control-center/server" || imported.startsWith("@knpkv/control-center/server/")) {
        this.error(`Browser view imports server entry "${imported}"`)
      }
    }
    const id = info.id.replaceAll("\\", "/").split("?")[0] ?? info.id
    if (id.includes("/src/server/")) this.error(`Browser view imports server source "${id}"`)
    const clientPath = id.split("/control-center/src/client/")[1]
    if (clientPath !== undefined && !viewModules.has(clientPath)) {
      this.error(`Browser view imports application runtime "${clientPath}"`)
    }
  }
})

it.layer(NodeServices.layer)((it) => {
  /** Follow static and lazy imports so a view cannot hide an application controller behind a child. */
  it.effect("bundles views without built-ins, server code or application runtime", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("..", import.meta.url))
      const entry = yield* path.fromFileUrl(new URL("../src/views.ts", import.meta.url))
      const result = yield* Effect.promise(() =>
        build({
          ...viewsConfig,
          configFile: false,
          root,
          plugins: [...(viewsConfig.plugins ?? []), browserBoundary()],
          logLevel: "silent",
          build: {
            ...viewsConfig.build,
            lib: {
              ...viewsConfig.build?.lib,
              entry,
              formats: ["es"]
            },
            write: false
          }
        })
      )
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
      for (const name of expectedViews) expect(exportedNames.has(name)).toBe(true)
    }))

  for (const mode of ["static", "dynamic"]) {
    it.effect(`rejects a ${mode} connected descendant of an allowed view`, () =>
      Effect.gen(function*() {
        const path = yield* Path.Path
        const entry = yield* path.fromFileUrl(new URL("../src/views.ts", import.meta.url))
        const leaf = yield* path.fromFileUrl(new URL("../src/client/BrowserSessionStatusView.tsx", import.meta.url))
        const connected = yield* path.fromFileUrl(new URL("../src/client/BrowserSession.tsx", import.meta.url))
        const fixture: Plugin = {
          name: "transitive-boundary-fixture",
          enforce: "pre",
          load(id) {
            if (id === entry) return `import ${JSON.stringify(leaf)}`
            if (id === leaf) {
              return mode === "dynamic"
                ? `void import(${JSON.stringify(connected)})`
                : `import ${JSON.stringify(connected)}`
            }
            if (id === connected) return "export const connected = true"
            return null
          }
        }
        yield* Effect.promise(() =>
          expect(build({
            ...viewsConfig,
            configFile: false,
            plugins: [fixture, browserBoundary()],
            logLevel: "silent",
            build: { ...viewsConfig.build, lib: { entry, formats: ["es"] }, write: false }
          })).rejects.toThrow("Browser view imports application runtime \"BrowserSession.tsx\"")
        )
      }))
  }
})
