import { expect, it } from "@effect/vitest"
import { isBuiltin } from "node:module"
import { build, type Plugin } from "vite"
import viewsConfig from "../vite.views.config.js"

const isNodeBuiltin: (specifier: string) => boolean = isBuiltin

/** Views must bundle for browsers without starting the application's owner-session runtime. */
it("bundles ./views without Node built-ins or the owner-session runtime", async () => {
  const moduleIds = new Set<string>()
  const browserBoundary: Plugin = {
    name: "reject-server-runtime",
    enforce: "pre",
    resolveId(path: string) {
      if (path.startsWith("node:") || isNodeBuiltin(path)) {
        this.error(`Browser entry imports Node built-in "${path}"`)
      }
      // Styles are verified by the real library build; this guard needs no built peer CSS.
      if (path.endsWith(".css")) return "\0browser-entry-styles"
      return null
    },
    load(id: string) {
      return id === "\0browser-entry-styles" ? "export default {}" : null
    },
    moduleParsed(info) {
      moduleIds.add(info.id)
    }
  }

  await build({
    ...viewsConfig,
    configFile: false,
    root: new URL("..", import.meta.url).pathname,
    plugins: [...viewsConfig.plugins ?? [], browserBoundary],
    logLevel: "silent",
    build: {
      ...viewsConfig.build,
      write: false
    }
  })
  expect(moduleIds.size).toBeGreaterThan(0)
  expect([...moduleIds].filter((id) => /(?:^|\/)(?:ownerSession\.ts|atoms\/runtime\.ts)$/.test(id))).toEqual([])
})
