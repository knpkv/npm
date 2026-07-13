import { relative } from "node:path"
import type { Plugin } from "vite"

export const CONTROL_CENTER_BUILD_GRAPH_VERSION = 1
export type ControlCenterBuildTarget = "client" | "server"

export type ControlCenterBuildModule = {
  readonly dynamicImports: ReadonlyArray<string>
  readonly id: string
  readonly imports: ReadonlyArray<string>
  readonly isEntry: boolean
}

export type ControlCenterBuildGraph = {
  readonly modules: ReadonlyArray<ControlCenterBuildModule>
  readonly target: ControlCenterBuildTarget
  readonly version: number
}

const portableId = (packageRoot: string, id: string): string => {
  const withoutQuery = id.split("?", 1)[0] ?? id
  const packagePath = relative(packageRoot, withoutQuery).replaceAll("\\", "/")
  return packagePath.startsWith("../") ? id.replaceAll("\\", "/") : packagePath
}

/** Emit the resolved Rollup module graph used by a Control Center build. */
export const controlCenterBuildGraph = (packageRoot: string, target: ControlCenterBuildTarget): Plugin => ({
  name: `control-center-${target}-build-graph`,
  generateBundle() {
    const modules = Array.from(this.getModuleIds())
      .flatMap((id): ReadonlyArray<ControlCenterBuildModule> => {
        const info = this.getModuleInfo(id)
        const portableModuleId = portableId(packageRoot, id)
        const isApplicationModule = portableModuleId === "index.html" || portableModuleId.startsWith("src/")
        return info === null || !isApplicationModule
          ? []
          : [
            {
              dynamicImports: info.dynamicallyImportedIds.map((dependency) => portableId(packageRoot, dependency)),
              id: portableModuleId,
              imports: info.importedIds.map((dependency) => portableId(packageRoot, dependency)),
              isEntry: info.isEntry
            }
          ]
      })
      .sort((left, right) => left.id.localeCompare(right.id))
    const graph: ControlCenterBuildGraph = {
      modules,
      target,
      version: CONTROL_CENTER_BUILD_GRAPH_VERSION
    }
    this.emitFile({
      fileName: "build-graph.json",
      source: `${JSON.stringify(graph, undefined, 2)}\n`,
      type: "asset"
    })
  }
})

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const decodeModule = (value: unknown): ControlCenterBuildModule | undefined => {
  if (!isRecord(value)) return undefined
  const { dynamicImports, id, imports, isEntry } = value
  return typeof id === "string" &&
      typeof isEntry === "boolean" &&
      isStringArray(imports) &&
      isStringArray(dynamicImports)
    ? { dynamicImports, id, imports, isEntry }
    : undefined
}

/** Decode an emitted graph without trusting build output JSON. */
export const decodeBuildGraph = (value: unknown): ControlCenterBuildGraph | undefined => {
  if (!isRecord(value)) return undefined
  const { modules, target, version } = value
  if (version !== CONTROL_CENTER_BUILD_GRAPH_VERSION || (target !== "client" && target !== "server")) return undefined
  if (!Array.isArray(modules)) return undefined
  const decoded = modules.map(decodeModule)
  if (decoded.some((module) => module === undefined)) return undefined
  return {
    modules: decoded.flatMap((module) => (module === undefined ? [] : [module])),
    target,
    version
  }
}

/** Return graph contract violations for the selected runtime target. */
export const inspectBuildGraph = (graph: ControlCenterBuildGraph): ReadonlyArray<string> => {
  const ids = graph.modules.flatMap(({ dynamicImports, id, imports }) => [id, ...imports, ...dynamicImports])
  const violations: Array<string> = []
  const entryIds = graph.modules.filter(({ isEntry }) => isEntry).map(({ id }) => id)

  if (graph.target === "client") {
    if (!ids.includes("src/client/main.tsx")) violations.push("client graph is missing src/client/main.tsx")
    if (!entryIds.includes("index.html")) violations.push("client graph is missing index.html")
    if (ids.some((id) => id.includes("src/server/"))) violations.push("client graph contains server source")
    if (ids.some((id) => id.startsWith("node:") || id.includes("/node:"))) {
      violations.push("client graph contains a Node built-in")
    }
  } else {
    const expectedEntries = ["src/api/index.ts", "src/domain/index.ts", "src/index.ts", "src/server/index.ts"]
    for (const entry of expectedEntries) {
      if (!entryIds.includes(entry)) violations.push(`server graph is missing ${entry}`)
    }
    if (ids.some((id) => id.includes("src/client/"))) violations.push("server graph contains client source")
    if (ids.some((id) => id === "@knpkv/rly" || id.includes("@knpkv/rly/"))) {
      violations.push("server graph contains rly")
    }
  }

  if (ids.some((id) => id.split(/[/?#]/).includes("prototypes"))) {
    violations.push(`${graph.target} graph contains prototype source`)
  }
  return violations
}
