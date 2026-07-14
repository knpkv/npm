import { describe, expect, it } from "vitest"
import { inspectModuleImports, inspectSourceBoundaries } from "../../scripts/source-boundaries.js"

describe("Control Center source boundaries", () => {
  it("accepts the intended dependency direction", () => {
    expect(inspectSourceBoundaries("src/client/page.tsx", "import { Thing } from \"../domain/index.js\"")).toEqual([])
    expect(inspectSourceBoundaries("src/server/main.ts", "import { Thing } from \"../domain/index.js\"")).toEqual([])
    expect(inspectSourceBoundaries("src/client/page.tsx", "import { Surface } from \"@knpkv/rly\"")).toEqual([])
  })

  it("rejects browser and API imports of server code", () => {
    expect(inspectSourceBoundaries("src/client/page.tsx", "import \"../server/main.js\"")).toEqual([
      {
        importPath: "../server/main.js",
        reason: "client code cannot import server code",
        sourcePath: "src/client/page.tsx"
      }
    ])
    expect(inspectSourceBoundaries("src/api/client.ts", "export * from \"../server/main.js\"")).toHaveLength(1)
    expect(inspectSourceBoundaries("src/client/page.tsx", "import \"@knpkv/control-center/server\"")).toHaveLength(1)
    expect(inspectSourceBoundaries("src/api/client.ts", "import \"../client/main.js\"")).toHaveLength(1)
    expect(inspectSourceBoundaries("src/server/main.ts", "import \"../client/main.js\"")).toHaveLength(1)
    expect(inspectSourceBoundaries("src/domain/release.ts", "import \"../api/index.js\"")).toHaveLength(1)
  })

  it("rejects presentation dependencies outside the browser", () => {
    expect(inspectSourceBoundaries("src/domain/release.ts", "import type { SurfaceProps } from \"@knpkv/rly\""))
      .toHaveLength(
        1
      )
    expect(inspectSourceBoundaries("src/server/main.ts", "import \"@knpkv/rly/styles.css\"")).toHaveLength(1)
    expect(inspectSourceBoundaries("src/api/schema.ts", "import(\"@knpkv/rly\")")).toHaveLength(1)
  })

  it("seals live plugin execution services from adapters, ordinary server, and agent modules", () => {
    const internalImport = "../plugins/internal/AuthorizedPluginExecutor.js"
    expect(inspectSourceBoundaries("src/server/routes/action.ts", `import ${JSON.stringify(internalImport)}`))
      .toContainEqual({
        importPath: internalImport,
        reason: "only internal plugin composition and the governed engine can import live plugin execution services",
        sourcePath: "src/server/routes/action.ts"
      })
    expect(inspectSourceBoundaries("src/server/agents/tools.ts", `import ${JSON.stringify(internalImport)}`))
      .toHaveLength(1)
    expect(
      inspectSourceBoundaries(
        "src/server/plugins/fake/FakePlugin.ts",
        "import { AuthorizedPluginExecutor } from \"../internal/AuthorizedPluginExecutor.js\""
      )
    ).toHaveLength(1)
    expect(
      inspectSourceBoundaries(
        "src/server/plugins/fake/FakePlugin.ts",
        "import type { AuthorizedPluginExecutorV1 } from \"../PluginExecutor.js\""
      )
    ).toEqual([])
    expect(
      inspectSourceBoundaries(
        "src/server/governance/GovernedActionEngine.ts",
        "import { AuthorizedPluginExecutor } from \"../plugins/internal/AuthorizedPluginExecutor.js\""
      )
    ).toEqual([])
  })

  it("rejects runtime imports from the approved prototype", () => {
    expect(
      inspectSourceBoundaries(
        "src/client/fixture.ts",
        "import \"../../../codecommit-web/src/client/prototypes/control-center/data.js\""
      )
    ).toHaveLength(1)
    expect(inspectSourceBoundaries("src/client/fixture.ts", "import \"@knpkv/codecommit-web\"")).toHaveLength(1)
  })

  it("sees import, export-from, and dynamic import syntax", () => {
    expect(
      inspectModuleImports(
        "src/client/module.ts",
        "import \"one\"\nexport { value } from \"two\"\nconst load = () => import(\"three\")\ntype Four = import(\"four\").Type"
      )
    ).toEqual(["one", "two", "three", "four"])
  })

  it("rejects unverifiable dynamic imports", () => {
    expect(inspectSourceBoundaries("src/client/module.ts", "const load = (path: string) => import(path)")).toEqual([
      {
        importPath: "<non-literal dynamic import>",
        reason: "production dynamic imports must use a literal module path",
        sourcePath: "src/client/module.ts"
      }
    ])
  })

  it("rejects unclassified bridge modules at the source root", () => {
    expect(inspectSourceBoundaries("src/bridge.ts", "export * from \"./server/index.js\"")).toContainEqual({
      importPath: "<unclassified source>",
      reason: "production source must belong to the root, API, client, domain, or server boundary",
      sourcePath: "src/bridge.ts"
    })
  })
})
