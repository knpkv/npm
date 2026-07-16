import * as TypeScript from "typescript"
import { describe, expect, it } from "vitest"

const forbiddenImport =
  /^(?:node:|@knpkv\/control-center|@knpkv\/(?:codecommit|jira|confluence|clockify)|distilled-aws)/

describe("browser package boundary", () => {
  it("does not import application, vendor, or Node modules", () => {
    const source = TypeScript.sys.readFile(new URL("../../src/index.ts", import.meta.url).pathname)
    if (source === undefined) throw new Error("Unable to read the rly public entry")

    const imports = TypeScript.preProcessFile(source).importedFiles.map(({ fileName }) => fileName)

    expect(imports.filter((specifier) => forbiddenImport.test(specifier))).toEqual([])
  })
})
