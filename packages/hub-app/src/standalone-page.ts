/**
 * The standalone shell's HTML: the manifest inline, the shell's stylesheet (rly's tokens and base, which the hub
 * page carries itself when attached), the app's own scoped stylesheets, and the shell module. Every element the
 * shell lends the app (mount root, header slot and outlet, portal root) carries `data-app`, so the app's scoped
 * CSS reaches what it portals too.
 *
 * @module
 */
import { Crypto, Effect, Schema } from "effect"
import { Hex } from "effect/encoding"
import { AppManifest } from "./manifest.js"

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;")

const encodeManifest = Schema.encodeSync(Schema.fromJsonString(AppManifest))

/** The manifest as JSON inside a script element: `<` can't close the element when written as an escape. */
const inlineManifest = (manifest: AppManifest): string => encodeManifest(manifest).replaceAll("<", "\\u003c")

/** The shell stylesheet's URL version: a hash of its text, so a changed stylesheet is never served from cache. */
export const shellCssVersion = (css: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((digests) => digests.digest("SHA-256", new TextEncoder().encode(css))),
    Effect.map((digest) => Hex.encode(digest).slice(0, 16))
  )

/** `shellVersion` ({@link shellCssVersion}) versions the stylesheet's URL, so the server can let browsers keep it. */
export const standaloneShellHtml = (manifest: AppManifest, shellVersion: string): string => {
  const app = `data-app="${escapeHtml(manifest.id)}"`
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `<title>${escapeHtml(manifest.module.label)}</title>`,
    `<link rel="stylesheet" href="/app/shell.css?v=${encodeURIComponent(shellVersion)}">`,
    ...manifest.client.css.map((file) => `<link rel="stylesheet" href="/app/assets/${escapeHtml(file)}">`),
    `<script type="application/json" id="hub-app-manifest">${inlineManifest(manifest)}</script>`,
    "<script type=\"module\" src=\"/app/shell.js\"></script>",
    "</head>",
    "<body>",
    "<header class=\"hub-app-standalone-header\"><span data-hub-shell=\"label\"></span>",
    "<nav aria-label=\"Pages\" data-hub-shell=\"pages\"></nav><span data-hub-shell=\"crumb\"></span>",
    `<span data-hub-shell="slot" ${app}></span><div data-hub-shell="outlet" ${app}></div></header>`,
    `<main id="hub-app-root" ${app}></main>`,
    `<div id="hub-app-portals" ${app}></div>`,
    "</body>",
    "</html>"
  ].join("\n")
}
