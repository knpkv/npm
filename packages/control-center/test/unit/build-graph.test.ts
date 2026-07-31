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

const serverGraph = (
  ids: ReadonlyArray<string>,
  providerImports: ReadonlyArray<string> = [
    "@aws-sdk/client-codepipeline",
    "src/server/plugins/codepipeline/CodePipelineStateDecoder.ts"
  ]
): ControlCenterBuildGraph => ({
  modules: [
    ...ids.map((id) => ({ dynamicImports: [], id, imports: [], isEntry: true })),
    {
      dynamicImports: [],
      id: "src/server/plugins/codepipeline/CodePipelineReadProvider.ts",
      imports: providerImports,
      isEntry: false
    },
    {
      dynamicImports: [],
      id: "src/server/plugins/codepipeline/CodePipelineStateProbe.ts",
      imports: ["src/server/plugins/codepipeline/CodePipelineStateDecoder.ts"],
      isEntry: true
    }
  ],
  target: "server",
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
        serverGraph(["src/index.ts", "src/api/index.ts", "src/domain/index.ts", "src/server/index.ts"])
      )
    ).toEqual([])
  })

  it("binds the shipped CodePipeline decoder to the production provider", () => {
    const entries = ["src/index.ts", "src/api/index.ts", "src/domain/index.ts", "src/server/index.ts"]
    const disconnected = inspectBuildGraph(
      serverGraph(entries, ["@distilled.cloud/aws/codepipeline"])
    )
    expect(disconnected).toContain("server CodePipeline provider is missing the official AWS SDK")
    expect(disconnected).toContain("server CodePipeline provider is missing the shipped state decoder")
    expect(inspectBuildGraph(serverGraph(entries))).toEqual([])
  })

  it("rejects cross-runtime and prototype modules", () => {
    expect(inspectBuildGraph(graph("client", ["index.html", "src/client/main.tsx", "src/server/secret.ts"]))).toContain(
      "client graph contains server source"
    )
    expect(
      inspectBuildGraph(
        serverGraph([
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

  it("rejects absolute developer paths in publishable graphs", () => {
    const clientGraph: ControlCenterBuildGraph = {
      modules: [
        {
          dynamicImports: [],
          id: "index.html",
          imports: ["src/client/main.tsx", "/home/developer/workspace/private.ts"],
          isEntry: true
        },
        { dynamicImports: [], id: "src/client/main.tsx", imports: [], isEntry: false }
      ],
      target: "client",
      version: CONTROL_CENTER_BUILD_GRAPH_VERSION
    }
    expect(inspectBuildGraph(clientGraph)).toContain("client graph contains an absolute path")
  })
})
