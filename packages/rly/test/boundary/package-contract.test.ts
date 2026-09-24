import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"
import * as TypeScript from "typescript"
import { describe, expect, it } from "vitest"
import { componentManifest } from "../../component-manifest.js"
import packageSource from "../../package.json?raw"

const sourceModules = import.meta.glob<string>("../../src/**/*.{ts,tsx}", {
  eager: true,
  import: "default",
  query: "?raw"
})

const isRecord = <UnparsedInput>(
  value: UnparsedInput
): value is UnparsedInput & Readonly<Record<string, Schema.Json>> => Predicate.isObjectOrArray(value) && value !== null

const moduleSpecifiers = (source: string): ReadonlyArray<string> => {
  const file = TypeScript.createSourceFile("module.tsx", source, TypeScript.ScriptTarget.Latest, true)
  const result: Array<string> = []
  const visit = (node: TypeScript.Node): void => {
    if (
      (TypeScript.isImportDeclaration(node) || TypeScript.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      TypeScript.isStringLiteral(node.moduleSpecifier)
    ) result.push(node.moduleSpecifier.text)
    if (TypeScript.isCallExpression(node) && node.expression.kind === TypeScript.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (argument !== undefined && TypeScript.isStringLiteralLike(argument)) result.push(argument.text)
    }
    TypeScript.forEachChild(node, visit)
  }
  visit(file)
  return result
}

describe("package contract", () => {
  it("inspects actual module edges without treating diff metadata as imports", () => {
    expect(
      moduleSpecifiers(
        "const text = \"rename from \"; const status = \"renamed\"; import \"react\"; export { x } from \"./x.js\"; import(\"forbidden\"); import(`template-edge`)"
      )
    ).toEqual(["react", "./x.js", "forbidden", "template-edge"])
  })
  it("keeps runtime dependencies on the exact approved implementation set", () => {
    const manifest: unknown = JSON.parse(packageSource)

    expect(isRecord(manifest)).toBe(true)
    if (!isRecord(manifest)) return

    expect(manifest.dependencies).toEqual({
      "@fontsource-variable/geist": "5.3.0",
      "@fontsource-variable/geist-mono": "5.3.0",
      "@pierre/diffs": "1.3.5",
      "lucide-react": "1.31.0",
      "radix-ui": "1.6.7"
    })
    expect(manifest.name).toBe("@knpkv/rly")
  })

  it("keeps every source module inside the framework-neutral boundary", () => {
    const allowed = new Set(["lucide-react", "radix-ui", "react"])
    const violations: Array<string> = []

    for (const [path, source] of Object.entries(sourceModules)) {
      for (const specifier of moduleSpecifiers(source)) {
        const isolatedDiffRenderer = path.includes("/src/diff/") && specifier.startsWith("@pierre/diffs")
        if (!specifier.startsWith(".") && !allowed.has(specifier) && !isolatedDiffRenderer) {
          violations.push(`${path}: import ${specifier}`)
        }
      }
      if (/\bdocument\.body\b|\bfetch\s*\(|\blocalStorage\b|\bsessionStorage\b/.test(source)) {
        violations.push(`${path}: raw browser host API`)
      }
    }

    expect(violations).toEqual([])
  })

  it("isolates the optional diff renderer from the normal package graph", () => {
    const rootEntry = componentManifest.entries.find(({ id }) => id === "root")
    const diffEntry = componentManifest.entries.find(({ id }) => id === "diff")

    expect(rootEntry).toMatchObject({
      aggregates: ["tokens", "foundations", "primitives", "patterns"],
      subpath: "."
    })
    expect(diffEntry).toMatchObject({
      aggregates: ["diff/workbench"],
      source: "src/diff/index.ts",
      subpath: "./diff"
    })

    for (const [path, source] of Object.entries(sourceModules)) {
      if (path.includes("/src/diff/")) continue
      expect(source, `${path} must not import the optional diff graph`).not.toMatch(
        /(?:from\s+|import\s*)["'][^"']*\/diff(?:\/|\.|["'])/
      )
    }
  })
})
