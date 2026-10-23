// Bundles the Usage app's client (with its own React, rly and effect) to dist/client, where the runner serves it.
import { build } from "esbuild"
import { BROWSER_TARGET } from "../../../browser-target.ts"

const common = { bundle: true, logLevel: "info", minify: true, sourcemap: true, target: BROWSER_TARGET }

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/client.tsx"],
    format: "esm",
    outfile: "dist/client/client.js",
    platform: "browser"
  }),
  build({
    ...common,
    entryPoints: ["src/client.css"],
    outfile: "dist/client/client.css",
    loader: { ".svg": "dataurl", ".woff2": "dataurl" }
  })
])
