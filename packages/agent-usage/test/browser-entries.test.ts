import { expect, it } from "@effect/vitest"
import { build } from "esbuild"
import { isBuiltin } from "node:module"

const isNodeBuiltin: (specifier: string) => boolean = isBuiltin

it.each(["views.ts", "limits/index.ts", "usage/index.ts"])(
  "bundles %s for the browser without Node built-ins",
  async (entry) => {
    const result = await build({
      entryPoints: [new URL(`../src/${entry}`, import.meta.url).pathname],
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
  }
)
