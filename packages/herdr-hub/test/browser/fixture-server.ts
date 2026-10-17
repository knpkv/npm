/** Serve the real hub stylesheet stack and deterministic browser fixtures. */
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { build } from "esbuild"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { BROWSER_TARGET } from "../../../../browser-target.ts"

const bundle = await build({
  absWorkingDir: fileURLToPath(new URL("../..", import.meta.url)),
  bundle: true,
  entryPoints: {
    approvals: "test/browser/fixture-entry.tsx",
    "connect-controls": "test/browser/connect-controls-entry.tsx"
  },
  format: "iife",
  // Module stylesheets carry SVG art; the hub build inlines it the same way.
  loader: { ".svg": "dataurl", ".woff2": "file" },
  outdir: "fixture-out",
  platform: "browser",
  target: BROWSER_TARGET,
  write: false
})
const page = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Approval request fixture</title>
<link rel="stylesheet" href="/assets/approvals.css">
</head><body data-rly-root data-rly-theme="dark"><div id="root"></div>
<script src="/assets/approvals.js" defer></script></body></html>`

const routes = Layer.mergeAll(
  HttpRouter.add("GET", "/", HttpServerResponse.html(page)),
  HttpRouter.add(
    "GET",
    "/connect-controls/",
    HttpServerResponse.html(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Stage notification fixture</title>
<link rel="stylesheet" href="/assets/connect-controls.css">
</head><body data-rly-root data-rly-theme="dark" class="connect-body"><div id="fleet-connect-root"></div>
<script src="/assets/connect-controls.js" defer></script></body></html>`)
  ),
  ...bundle.outputFiles.map((output) =>
    HttpRouter.add(
      "GET",
      `/assets/${output.path.split("/").at(-1)}`,
      HttpServerResponse.uint8Array(output.contents, {
        contentType: output.path.endsWith(".js")
          ? "text/javascript"
          : output.path.endsWith(".css")
          ? "text/css"
          : "font/woff2"
      })
    )
  )
)

const server = Layer.unwrap(
  Effect.map(
    Config.Int("APPROVALS_FIXTURE_PORT"),
    (port) => NodeHttpServer.layer(createServer, { host: "127.0.0.1", port })
  )
)
NodeRuntime.runMain(Layer.launch(HttpRouter.serve(routes, { disableLogger: true }).pipe(Layer.provide(server))))
