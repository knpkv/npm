import { build } from "esbuild"

const common = {
  bundle: true,
  logLevel: "info",
  minify: true,
  sourcemap: true,
  target: "es2022"
}

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/approval-client.tsx"],
    format: "iife",
    outfile: "dist/approval.js",
    platform: "browser"
  }),
  build({
    ...common,
    entryPoints: ["src/connect-entry.ts"],
    format: "iife",
    outfile: "dist/connect.js",
    platform: "browser"
  }),
  build({
    ...common,
    entryPoints: ["src/approval-service-worker.ts"],
    format: "iife",
    outfile: "dist/approval-sw.js",
    platform: "browser"
  }),
  build({
    ...common,
    assetNames: "[name]",
    entryNames: "index",
    entryPoints: ["src/assets.css"],
    loader: { ".woff2": "file" },
    outdir: "dist"
  })
])
