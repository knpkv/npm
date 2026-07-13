import { describe, expect, it } from "vitest"
import {
  CONTROL_CENTER_BUILD_GRAPH_VERSION,
  type ControlCenterBuildGraph,
  decodeBuildGraph,
  inspectBuildGraph
} from "../../scripts/build-graph.js"

const graph = (target: "client" | "server", ids: ReadonlyArray<string>): ControlCenterBuildGraph => ({
  modules: ids.map((id) => ({ dynamicImports: [], id, imports: [], isEntry: true })),
  target,
  version: CONTROL_CENTER_BUILD_GRAPH_VERSION
})

describe("resolved build graph contract", () => {
  it("accepts the two intended entry graphs", () => {
    const clientGraph: ControlCenterBuildGraph = {
      modules: [
        { dynamicImports: [], id: "index.html", imports: ["src/client/main.tsx"], isEntry: true },
        { dynamicImports: [], id: "src/client/main.tsx", imports: [], isEntry: false }
      ],
      target: "client",
      version: CONTROL_CENTER_BUILD_GRAPH_VERSION
    }
    expect(inspectBuildGraph(clientGraph)).toEqual([])
    expect(
      inspectBuildGraph(
        graph("server", ["src/index.ts", "src/api/index.ts", "src/domain/index.ts", "src/server/index.ts"])
      )
    ).toEqual([])
  })

  it("rejects cross-runtime and prototype modules", () => {
    expect(inspectBuildGraph(graph("client", ["index.html", "src/client/main.tsx", "src/server/secret.ts"]))).toContain(
      "client graph contains server source"
    )
    expect(
      inspectBuildGraph(
        graph("server", [
          "src/index.ts",
          "src/api/index.ts",
          "src/domain/index.ts",
          "src/server/index.ts",
          "@knpkv/rly/patterns"
        ])
      )
    ).toContain("server graph contains rly")
    expect(
      inspectBuildGraph(graph("client", ["index.html", "src/client/main.tsx", "../prototypes/control-center/data.ts"]))
    ).toContain(
      "client graph contains prototype source"
    )
  })

  it("rejects malformed or version-skewed graph data", () => {
    expect(decodeBuildGraph({ modules: [], target: "client", version: 999 })).toBeUndefined()
    expect(decodeBuildGraph({ modules: "not-an-array", target: "server", version: 1 })).toBeUndefined()
    expect(
      decodeBuildGraph({
        modules: [{ dynamicImports: [], id: 42, imports: [], isEntry: true }],
        target: "client",
        version: 1
      })
    ).toBeUndefined()
  })
})
