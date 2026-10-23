// Bundles the standalone shell, which the runner serves at /app/shell.js (effect inlined) and /app/shell.css (rly).
import { build } from "esbuild"
import { BROWSER_TARGET } from "../../../browser-target.ts"

await build({
  bundle: true,
  entryPoints: ["src/standalone.ts"],
  format: "esm",
  logLevel: "info",
  minify: true,
  outfile: "dist/standalone-shell.js",
  platform: "browser",
  target: BROWSER_TARGET
})

await build({
  bundle: true,
  entryPoints: ["src/standalone.css"],
  loader: { ".svg": "dataurl", ".woff2": "dataurl" },
  logLevel: "info",
  minify: true,
  outfile: "dist/standalone-shell.css",
  target: BROWSER_TARGET
})
