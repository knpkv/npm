import { describe, expect, it } from "@effect/vitest"
import { scanScript } from "../src/server/review/ScriptScanner.js"

describe("scanScript", () => {
  it("finds static imports, re-exports, dynamic imports and require calls", () => {
    const text = [
      "import a from \"./a\"",
      "import \"./side-effect\"",
      "import {",
      "  b,",
      "} from \"./b.js\"",
      "export * from \"./c\"",
      "const d = await import(\"./d\")",
      "const e = require(\"./e\")"
    ].join("\n")
    expect(scanScript(text).specifiers).toEqual(["./a", "./side-effect", "./b.js", "./c", "./d", "./e"])
  })

  it("never reads an import out of a comment, a string or a template", () => {
    const text = [
      "// import x from \"./commented\"",
      "/* export * from \"./blocked\" */",
      "const message = \"import y from './quoted'\"",
      "const template = `from \"./templated\"`",
      "const label = \"from\"",
      "const value = \"./not-an-import\""
    ].join("\n")
    expect(scanScript(text).specifiers).toEqual([])
  })

  it("ranges a top-level function to its closing brace, ignoring braces in strings and comments", () => {
    const text = [
      "export async function connect(stageId: string) {",
      "  const open = \"{\" // }",
      "  return open",
      "}",
      "",
      "export const close = (id: string) => id",
      "",
      "export const decode = (",
      "  value: string",
      ") => {",
      "  return value",
      "}",
      "",
      "export class Socket {",
      "  send() {}",
      "}",
      "const ignored = 1"
    ].join("\n")
    expect(scanScript(text).declarations).toEqual([
      { name: "connect()", start: 1, end: 4 },
      { name: "close()", start: 6, end: 6 },
      { name: "decode()", start: 8, end: 12 },
      { name: "Socket", start: 14, end: 16 }
    ])
  })

  it("does not take a nested function for a top-level one", () => {
    const text = ["export function outer() {", "  function inner() {", "    return 1", "  }", "}"].join("\n")
    expect(scanScript(text).declarations).toEqual([{ name: "outer()", start: 1, end: 5 }])
  })

  it("keeps overload signatures and their implementation as one part", () => {
    const text = [
      "export function parse(value: string): number",
      "export function parse(value: number): number",
      "export function parse(value: string | number): number {",
      "  return Number(value)",
      "}"
    ].join("\n")
    expect(scanScript(text).declarations).toEqual([{ name: "parse()", start: 1, end: 5 }])
  })

  it("finds function-valued constants however they are written", () => {
    const text = [
      "export const read = Effect.fn(\"Reads.read\")(function*(ref: string) {",
      "  return ref",
      "})",
      "export const id = <A>(value: A): A => {",
      "  return value",
      "}",
      "export const handle: (value: number) => void = (value) => {",
      "  void value",
      "}",
      "const total = (a + b) * 2",
      "const config = { retries: 3 }"
    ].join("\n")
    expect(scanScript(text).declarations).toEqual([
      { name: "read()", start: 1, end: 3 },
      { name: "id()", start: 4, end: 6 },
      { name: "handle()", start: 7, end: 9 }
    ])
  })

  it("does not take data that only holds callbacks for a function", () => {
    const text = [
      "const config = { retry: () => 3 }",
      "const ids = rows.map((row) => row.id)",
      "const pick = flag ? (value) => value : fallback",
      "export const load = async (ref: string) => ref",
      "const step = function* () {",
      "  yield 1",
      "}",
      "const one = value => value",
      "const pinned = <F extends () => void>(f: F): F => f"
    ].join("\n")
    expect(scanScript(text).declarations.map((declaration) => declaration.name)).toEqual([
      "load()",
      "step()",
      "one()",
      "pinned()"
    ])
  })

  it("takes a function passed straight to a wrapper for a function, but not one passed to an array method", () => {
    const text = [
      "export const run = Effect.fn(function* (ref: string) {",
      "  return ref",
      "})",
      "const quick = Effect.fnUntraced(function* () {",
      "  yield* Effect.void",
      "})",
      "const Row = memo((props: Props) => props.label)",
      "const Field = forwardRef<HTMLInputElement, Props>((props, ref) => null)",
      "const kept = rows.filter((row) => row.kept)",
      "const total = rows.reduce((sum, row) => sum + row.size, 0)",
      "const program = Effect.gen(function* () {",
      "  yield* Effect.void",
      "})"
    ].join("\n")
    expect(scanScript(text).declarations.map((declaration) => declaration.name)).toEqual([
      "run()",
      "quick()",
      "Row()",
      "Field()"
    ])
  })
})
