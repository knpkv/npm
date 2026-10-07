/**
 * Preload rly's Geist UI font from a product shell's built index.html.
 *
 * rly's styles.css asks for Geist only once the stylesheet has been parsed and a text node needs it,
 * so without a preload the first paint uses the metric-matched fallback and Geist swaps in later.
 * Add `rlyFontPreload()` to a Vite shell's plugins: after the bundle is written it finds the woff2
 * asset the CSS references and prepends `<link rel="preload" as="font" crossorigin>` for that exact
 * hashed file, so the preload and the CSS url() can never point at two different assets.
 *
 * A build with no Geist asset fails, because a shell that imports rly styles always emits one.
 * The dev server is left alone: it serves the font under a /@fs URL with no stable name, and dev
 * first-paint timing is not what the font-swap budget measures.
 */
import { Data } from "effect"
import type { HtmlTagDescriptor, Plugin } from "vite"

/** The rly woff2 a shell preloads, as Fontsource names it. */
export const RLY_PRELOADED_FONT = "geist-latin-wght-normal.woff2"

/** The build emitted no Geist asset, so the shell does not load rly's styles or the font was renamed. */
export class RlyFontPreloadMissingError extends Data.TaggedError("RlyFontPreloadMissingError")<{
  readonly font: string
  readonly html: string
}> {
  override get message(): string {
    return `${this.html}: the build emitted no ${this.font}, so there is nothing to preload`
  }
}

/** The part of a written Vite bundle the preload reads: each output's kind, file and source names. */
export type FontBundle = Readonly<
  Record<string, { readonly fileName: string; readonly names?: ReadonlyArray<string>; readonly type: string }>
>

/** The emitted file name of the asset built from `font`, if the bundle has one. */
export const findFontAsset = (bundle: FontBundle, font: string): string | undefined =>
  Object.values(bundle).find((output) =>
    output.type === "asset" && (output.names ?? []).some((name) => name === font || name.endsWith(`/${font}`))
  )?.fileName

/** The preload tag for `html`'s build, or a tagged failure when the bundle carries no Geist. */
export const fontPreloadTags = (
  bundle: FontBundle,
  base: string,
  html: string
): ReadonlyArray<HtmlTagDescriptor> => {
  const fileName = findFontAsset(bundle, RLY_PRELOADED_FONT)
  if (fileName === undefined) throw new RlyFontPreloadMissingError({ font: RLY_PRELOADED_FONT, html })
  return [{
    attrs: { as: "font", crossorigin: "", href: `${base}${fileName}`, rel: "preload", type: "font/woff2" },
    injectTo: "head-prepend",
    tag: "link"
  }]
}

/** The Vite plugin; see the module comment. */
export const rlyFontPreload = (): Plugin => {
  let base = "/"
  return {
    apply: "build",
    configResolved(config) {
      base = config.base
    },
    name: "rly-font-preload",
    transformIndexHtml: {
      handler(_html, context) {
        return context.bundle === undefined ? undefined : [...fontPreloadTags(context.bundle, base, context.path)]
      },
      order: "post"
    }
  }
}
