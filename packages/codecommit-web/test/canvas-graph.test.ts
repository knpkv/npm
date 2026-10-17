import { describe, expect, it } from "@effect/vitest"
import { CanvasGraph } from "@knpkv/review/canvas"
import { Schema } from "effect"
import { buildCanvasGraph, type CanvasSourceFile } from "../src/server/review/CanvasGraphBuilder.js"

const text = (before: string | null, after: string | null): CanvasSourceFile["content"] => ({
  _tag: "Text",
  before,
  after
})

const added = (path: string, after: string): CanvasSourceFile => ({
  path,
  status: "added",
  previousPath: null,
  content: text(null, after)
})

const socket = [
  "import { decode } from \"./protocol.js\"",
  "",
  "export type Handle = { readonly id: string }",
  "",
  "export async function connect(stageId: string) {",
  "  return decode(stageId)",
  "}",
  "",
  "export const close = (stageId: string) => {",
  "  return stageId",
  "}",
  ""
].join("\n")

const protocol = "export const decode = (value: string) => value\n"
const worker = "import { connect } from \"./socket\"\nexport * from \"../stage/index\"\nconnect(\"a\")\n"
const stageIndex = "export const stage = 1\n"

describe("buildCanvasGraph", () => {
  const graph = buildCanvasGraph("e81f0c9", [
    added("sync-worker/socket.ts", socket),
    added("sync-worker/protocol.ts", protocol),
    added("sync-worker/worker.ts", worker),
    added("stage/index.ts", stageIndex),
    added("README.md", "# Relay\n")
  ])

  it("decodes as a canvas graph", () => {
    expect(Schema.decodeUnknownResult(CanvasGraph, { onExcessProperty: "error" })(graph)._tag).toBe("Success")
  })

  it("counts changed lines per file", () => {
    const file = graph.files.find((entry) => entry.path === "sync-worker/socket.ts")
    expect([file?.added, file?.removed]).toEqual([11, 0])
  })

  it("resolves relative imports between files of the change, with .js, extensionless and index specifiers", () => {
    expect(graph.dependencies).toEqual({
      _tag: "Recorded",
      edges: [
        {
          from: "sync-worker/socket.ts",
          to: "sync-worker/protocol.ts",
          relation: "imports",
          fromPart: null,
          toPart: null
        },
        {
          from: "sync-worker/worker.ts",
          to: "sync-worker/socket.ts",
          relation: "imports",
          fromPart: null,
          toPart: null
        },
        { from: "sync-worker/worker.ts", to: "stage/index.ts", relation: "imports", fromPart: null, toPart: null }
      ]
    })
  })

  it("splits a file into its changed functions and its imports and types", () => {
    const file = graph.files.find((entry) => entry.path === "sync-worker/socket.ts")
    expect(file?.parts).toEqual({
      _tag: "Recorded",
      items: [
        { name: "connect()", kind: "added", movedPath: null, lines: { start: 5, end: 7 }, added: 3, removed: 0 },
        { name: "close()", kind: "added", movedPath: null, lines: { start: 9, end: 11 }, added: 3, removed: 0 },
        { name: "imports and types", kind: "added", movedPath: null, lines: { start: 1, end: 3 }, added: 2, removed: 0 }
      ]
    })
  })

  // The shared closing brace stays unchanged in the line diff, so it counts for neither side.
  it("names a modified, an added and a removed function", () => {
    const before = "export function keep() {\n  return 1\n}\n\nexport function gone() {\n  return 2\n}\n"
    const after = "export function keep() {\n  return 3\n}\n\nexport function fresh() {\n  return 4\n}\n"
    const changed = buildCanvasGraph("head", [{
      path: "a.ts",
      status: "modified",
      previousPath: null,
      content: text(before, after)
    }])
    const parts = changed.files[0]?.parts
    expect(
      parts?._tag === "Recorded" ? parts.items.map((part) => [part.name, part.kind, part.added, part.removed]) : []
    )
      .toEqual([
        ["keep()", "modified", 1, 1],
        ["fresh()", "added", 2, 0],
        ["gone()", "removed", 0, 2]
      ])
  })

  it("records no parts for a file it cannot parse as TypeScript", () => {
    expect(graph.files.find((entry) => entry.path === "README.md")?.parts).toEqual({ _tag: "NotRecorded" })
  })

  it("keeps a change with no TypeScript as explicitly not recorded, naming its language", () => {
    const go = buildCanvasGraph("head", [added("main.go", "package main\n"), added("util.go", "package main\n")])
    expect(go.dependencies).toEqual({ _tag: "NotRecorded", language: "Go" })
  })

  it("never guesses an edge to a file outside the change", () => {
    const lonely = buildCanvasGraph("head", [added("a.ts", "import { b } from \"./b.js\"\nimport x from \"react\"\n")])
    expect(lonely.dependencies).toEqual({ _tag: "Recorded", edges: [] })
  })

  it("keeps a binary file in the change without counts or parts", () => {
    const binary = buildCanvasGraph("head", [{
      path: "logo.png",
      status: "added",
      previousPath: null,
      content: { _tag: "Opaque" }
    }])
    expect(binary.files[0]).toMatchObject({ added: 0, removed: 0, parts: { _tag: "NotRecorded" } })
  })

  it("records no parts for a file with more parts than the canvas can show", () => {
    const many = Array.from({ length: 201 }, (_, index) => `export function f${index}() {}`).join("\n")
    const graph = buildCanvasGraph("head", [added("generated.ts", `${many}\n`)])
    expect(graph.files[0]?.parts).toEqual({ _tag: "NotRecorded" })
  })

  it("records no dependency data past the edge limit instead of failing the reading", () => {
    const sources = Array.from({ length: 72 }, (_, index) =>
      added(
        `src/f${index}.ts`,
        Array.from({ length: 72 }, (_, other) => `import "./f${other}"`).join("\n") + "\n"
      ))
    expect(buildCanvasGraph("head", sources).dependencies).toEqual({ _tag: "NotRecorded", language: null })
  })
})
