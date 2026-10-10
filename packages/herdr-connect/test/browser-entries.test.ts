import { expect, it } from "@effect/vitest"
import { build } from "esbuild"
import { isBuiltin } from "node:module"

const isNodeBuiltin: (specifier: string) => boolean = isBuiltin

const entries = [
  { name: "./surface", source: "../src/client.tsx" },
  { name: "./usage", source: "../src/usage-entry.ts" },
  { name: "./client", source: "../src/client-entry.tsx" }
]

it.each(entries)("bundles $name for the browser without Node built-ins", async ({ source }) => {
  const result = await build({
    entryPoints: [new URL(source, import.meta.url).pathname],
    platform: "browser",
    bundle: true,
    write: false,
    format: "esm",
    loader: { ".css": "empty" },
    logLevel: "silent",
    plugins: [
      {
        name: "reject-node-builtins",
        setup(build) {
          build.onResolve({ filter: /.*/ }, ({ path }: { readonly path: string }) => {
            if (path.startsWith("node:") || isNodeBuiltin(path)) {
              return { errors: [{ text: `Browser entry imports Node built-in "${path}"` }] }
            }
            return undefined
          })
        }
      }
    ]
  })
  expect(result.outputFiles.length).toBeGreaterThan(0)
})
