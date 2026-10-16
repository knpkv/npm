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
})
