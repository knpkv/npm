import * as TypeScript from "typescript"
import { describe, expect, it } from "vitest"
import { findForbiddenPublicTypeOrigins } from "../../scripts/packed/public-type-origins.js"

const virtualProgram = (): { readonly entry: string; readonly program: TypeScript.Program } => {
  const entry = "/workspace/index.d.ts"
  const files = new Map([
    [
      entry,
      `export {
        leaked,
        privateSafe,
        safe,
        type LeakedProps,
        type SafeProps,
        type WorkerProps
      } from "./public.js"`
    ],
    [
      "/workspace/public.d.ts",
      `import type { VendorHandle } from "@pierre/diffs/react"
      import type { WorkerManager } from "@pierre/diffs/worker"
      export interface SafeProps { readonly label: string }
      export interface LeakedProps { readonly handle: VendorHandle }
      export interface WorkerProps { readonly manager: WorkerManager }
      interface PrivateState { readonly manager: WorkerManager }
      export declare const safe: (props: SafeProps) => string
      export declare const leaked: (handle: VendorHandle) => void
      export declare const privateSafe: (label: string) => string`
    ],
    [
      "/node_modules/@pierre/diffs/react.d.ts",
      `export interface VendorHandle { readonly vendorRevision: string }`
    ],
    [
      "/node_modules/@pierre/diffs/worker.d.ts",
      `export interface WorkerManager { readonly workerCount: number }`
    ]
  ])
  const options: TypeScript.CompilerOptions = {
    module: TypeScript.ModuleKind.NodeNext,
    moduleResolution: TypeScript.ModuleResolutionKind.NodeNext,
    strict: true,
    target: TypeScript.ScriptTarget.ES2022
  }
  const defaultHost = TypeScript.createCompilerHost(options)
  const host: TypeScript.CompilerHost = {
    ...defaultHost,
    fileExists: (fileName) => files.has(fileName) || defaultHost.fileExists(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const source = files.get(fileName)
      return source === undefined
        ? defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
        : TypeScript.createSourceFile(fileName, source, languageVersion, true, TypeScript.ScriptKind.TS)
    },
    readFile: (fileName) => files.get(fileName) ?? defaultHost.readFile(fileName),
    resolveModuleNames: (moduleNames, containingFile) =>
      moduleNames.map((moduleName) => {
        const resolvedFileName = moduleName === "./public.js"
          ? "/workspace/public.d.ts"
          : moduleName === "@pierre/diffs/react"
          ? "/node_modules/@pierre/diffs/react.d.ts"
          : moduleName === "@pierre/diffs/worker"
          ? "/node_modules/@pierre/diffs/worker.d.ts"
          : undefined
        if (resolvedFileName !== undefined) {
          return {
            extension: TypeScript.Extension.Dts,
            isExternalLibraryImport: !moduleName.startsWith("."),
            resolvedFileName
          }
        }
        return TypeScript.resolveModuleName(moduleName, containingFile, options, defaultHost).resolvedModule
      })
  }
  return { entry, program: TypeScript.createProgram({ host, options, rootNames: [entry] }) }
}

describe("public declaration type origins", () => {
  it("rejects root and subpath vendor types while preserving private vendor state", () => {
    const { entry, program } = virtualProgram()
    expect(findForbiddenPublicTypeOrigins(program, entry, ["@pierre/diffs"])).toEqual([
      {
        exportName: "leaked",
        sourceFile: "/node_modules/@pierre/diffs/react.d.ts"
      },
      {
        exportName: "LeakedProps",
        sourceFile: "/node_modules/@pierre/diffs/react.d.ts"
      },
      {
        exportName: "WorkerProps",
        sourceFile: "/node_modules/@pierre/diffs/worker.d.ts"
      }
    ])
  })
})
