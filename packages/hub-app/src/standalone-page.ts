/**
 * The standalone shell's HTML: the manifest inline, the shell's stylesheet (rly's tokens and base, which the hub
 * page carries itself when attached), the app's own scoped stylesheets, and the shell module.
 *
 * @module
 */
import { Schema } from "effect"
import { AppManifest } from "./manifest.js"

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;")

const encodeManifest = Schema.encodeSync(Schema.fromJsonString(AppManifest))

/** The manifest as JSON inside a script element: `<` can't close the element when written as an escape. */
const inlineManifest = (manifest: AppManifest): string => encodeManifest(manifest).replaceAll("<", "\\u003c")

export const standaloneShellHtml = (manifest: AppManifest): string =>
  [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `<title>${escapeHtml(manifest.module.label)}</title>`,
    "<link rel=\"stylesheet\" href=\"/app/shell.css\">",
    ...manifest.client.css.map((file) => `<link rel="stylesheet" href="/app/assets/${escapeHtml(file)}">`),
    `<script type="application/json" id="hub-app-manifest">${inlineManifest(manifest)}</script>`,
    "<script type=\"module\" src=\"/app/shell.js\"></script>",
    "</head>",
    "<body>",
    "<header class=\"hub-app-standalone-header\"><span data-hub-shell=\"label\"></span>",
    "<nav aria-label=\"Pages\" data-hub-shell=\"pages\"></nav><span data-hub-shell=\"crumb\"></span>",
    "<span data-hub-shell=\"slot\"></span><div data-hub-shell=\"outlet\"></div></header>",
    `<main id="hub-app-root" data-app="${escapeHtml(manifest.id)}"></main>`,
    "<div id=\"hub-app-portals\"></div>",
    "</body>",
    "</html>"
  ].join("\n")
