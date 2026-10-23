// Bundles the standalone shell, which the runner serves at /app/shell.js; effect is inlined.
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
