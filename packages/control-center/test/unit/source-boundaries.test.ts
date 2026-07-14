import { describe, expect, it } from "vitest"
import {
  inspectModuleImports,
  inspectSourceBoundaries,
  inspectStylesheetBoundaries
} from "../../scripts/source-boundaries.js"

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

  it("rejects quoted and unquoted prototype references in stylesheet imports", () => {
    const sourcePath = "src/client/styles/imports.css"
    const sources = [
      "@import \"@knpkv/codecommit-web/styles.css\";",
      "@import url(\"../../../codecommit-web/src/client/prototypes/control-center/theme.css\");",
      "@import url(../../../codecommit-web/src/client/prototypes/control-center/tokens.css);"
    ]

    for (const source of sources) {
      expect(inspectStylesheetBoundaries(sourcePath, source)).toEqual([
        {
          importPath: expect.stringContaining("codecommit-web"),
          reason: "production code cannot import prototype runtime",
          sourcePath
        }
      ])
    }
  })

  it("rejects quoted and unquoted prototype references in stylesheet URLs", () => {
    const sourcePath = "src/client/styles/assets.css"
    const sources = [
      ".hero { background-image: url(\"../../../codecommit-web/src/client/prototypes/control-center/hero.svg\") }",
      ".hero { background-image: url(../../../codecommit-web/src/client/prototypes/control-center/hero.svg) }"
    ]

    for (const source of sources) {
      expect(inspectStylesheetBoundaries(sourcePath, source)).toHaveLength(1)
    }
  })

  it("rejects prototype dependencies hidden in CSS Modules compositions", () => {
    const sourcePath = "src/client/styles/actions.module.css"
    const sources = [
      ".action { composes: button from \"@knpkv/codecommit-web/actions.module.css\"; }",
      ".action { composes: button from '../../../codecommit-web/src/client/prototypes/control-center/actions.module.css'; }",
      ".action { composes: button from ../../../codecommit-web/src/client/prototypes/control-center/actions.module.css; }"
    ]

    for (const source of sources) {
      expect(inspectStylesheetBoundaries(sourcePath, source)).toEqual([
        {
          importPath: expect.stringContaining("codecommit-web"),
          reason: "production code cannot import prototype runtime",
          sourcePath
        }
      ])
    }
  })

  it("rejects prototype dependencies hidden in CSS Modules value imports", () => {
    const sourcePath = "src/client/styles/tokens.module.css"
    const sources = [
      "@value accent from \"@knpkv/codecommit-web/tokens.css\";",
      "@value spacing, radius from '../../../codecommit-web/src/client/prototypes/control-center/tokens.css';",
      "@value accent from ../../../codecommit-web/src/client/prototypes/control-center/tokens.css;"
    ]

    for (const source of sources) {
      expect(inspectStylesheetBoundaries(sourcePath, source)).toHaveLength(1)
    }
  })

  it("rejects prototype dependencies hidden in canonical ICSS imports", () => {
    const sourcePath = "src/client/styles/tokens.module.css"
    const sources = [
      ":import(\"@knpkv/codecommit-web/tokens.css\") { accent: brandAccent; }",
      ":import('../../../codecommit-web/src/client/prototypes/control-center/tokens.css') { spacing: space; }",
      ":import(../../../codecommit-web/src/client/prototypes/control-center/tokens.css) { radius: radius; }"
    ]

    for (const source of sources) {
      expect(inspectStylesheetBoundaries(sourcePath, source)).toHaveLength(1)
    }
  })

  it("ignores prototype-looking CSS Modules and ICSS dependencies inside comments", () => {
    expect(
      inspectStylesheetBoundaries(
        "src/client/styles/commented.module.css",
        [
          "/* .action { composes: button from \"@knpkv/codecommit-web/actions.module.css\"; } */",
          "/* @value accent from \"../../../codecommit-web/src/client/prototypes/control-center/tokens.css\"; */",
          "/* :import(\"@knpkv/codecommit-web/tokens.css\") { accent: brandAccent; } */"
        ].join("\n")
      )
    ).toEqual([])
  })

  it("accepts ordinary local stylesheet asset URLs", () => {
    expect(
      inspectStylesheetBoundaries(
        "src/client/styles/assets.css",
        [
          "@import \"./tokens.css\";",
          ".action { composes: button from \"./actions.module.css\"; }",
          "@value accent from \"./tokens.css\";",
          ":import(\"./tokens.css\") { accent: brandAccent; }",
          ":import(./spacing.css) { spacing: space; }",
          ".brand { background-image: url('../assets/brand.svg') }",
          ".icon { mask-image: url(../assets/icon.svg?v=2#mask) }",
          ".font { src: url(\"../fonts/inter.woff2\") format(\"woff2\") }"
        ].join("\n")
      )
    ).toEqual([])
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

  it("inspects the first specifier of multi-argument dynamic imports and require calls", () => {
    expect(
      inspectSourceBoundaries(
        "src/client/module.ts",
        [
          "const loadServer = () => import(\"../server/main.js\", { with: { type: \"json\" } })",
          "const requireServer = () => require(\"../server/legacy.js\", { ignored: true })"
        ].join("\n")
      )
    ).toEqual([
      {
        importPath: "../server/main.js",
        reason: "client code cannot import server code",
        sourcePath: "src/client/module.ts"
      },
      {
        importPath: "../server/legacy.js",
        reason: "client code cannot import server code",
        sourcePath: "src/client/module.ts"
      }
    ])
  })

  it("rejects non-literal first specifiers in multi-argument dynamic imports and require calls", () => {
    expect(
      inspectSourceBoundaries(
        "src/client/module.ts",
        [
          "const load = (path: string) => import(path, { with: { type: \"json\" } })",
          "const loadLegacy = (path: string) => require(path, { ignored: true })"
        ].join("\n")
      )
    ).toEqual([
      {
        importPath: "<non-literal dynamic import>",
        reason: "production dynamic imports must use a literal module path",
        sourcePath: "src/client/module.ts"
      },
      {
        importPath: "<non-literal dynamic import>",
        reason: "production dynamic imports must use a literal module path",
        sourcePath: "src/client/module.ts"
      }
    ])
  })

  it("accepts allowed local multi-argument dynamic imports", () => {
    expect(
      inspectSourceBoundaries(
        "src/client/module.ts",
        "const load = () => import(\"../domain/release.js\", { with: { type: \"json\" } })"
      )
    ).toEqual([])
  })

  it("ignores empty import and require calls without indexing past their arguments", () => {
    expect(inspectModuleImports("src/client/module.ts", "import(); require()")).toEqual([])
  })

  it("rejects unclassified bridge modules at the source root", () => {
    expect(inspectSourceBoundaries("src/bridge.ts", "export * from \"./server/index.js\"")).toContainEqual({
      importPath: "<unclassified source>",
      reason: "production source must belong to the root, API, client, domain, or server boundary",
      sourcePath: "src/bridge.ts"
    })
  })
})
