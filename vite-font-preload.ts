/**
 * Preload rly's Geist faces, UI and mono, from a product shell's built index.html.
 *
 * rly's styles.css asks for Geist only once the stylesheet has been parsed and a text node needs it,
 * so without a preload the first paint uses the metric-matched fallback and Geist swaps in later.
 * Add `rlyFontPreload()` to a Vite shell's plugins: after the bundle is written it finds the woff2
 * assets the CSS references and prepends `<link rel="preload" as="font" crossorigin>` for each exact
 * hashed file, so the preloads and the CSS url()s can never point at different assets. Both faces:
 * mono sets ids and kickers, and a late mono swap re-wrapped lines (hub Approvals CLS 0.069 at 390).
 *
 * A build missing either face fails, because a shell that imports rly styles always emits both.
 * The dev server is left alone: it serves the font under a /@fs URL with no stable name, and dev
 * first-paint timing is not what the font-swap budget measures.
 */
import { Data } from "effect"
import type { HtmlTagDescriptor, Plugin } from "vite"
// A relative source import: the workspace root does not depend on @knpkv/rly, and fonts.ts has no imports.
import { RLY_FONT_FACES } from "./packages/rly/src/tokens/fonts.ts"

/** The rly woff2 files a shell preloads: rly's own list of every face its styles load. */
export const RLY_PRELOADED_FONTS: ReadonlyArray<string> = RLY_FONT_FACES.map(({ file }) => file)

/** The build emitted no asset for a Geist face, so the shell does not load rly's styles or the font was renamed. */
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

/** The preload tags for `html`'s build, one per Geist face, or a tagged failure when a face is missing. */
export const fontPreloadTags = (
  bundle: FontBundle,
  base: string,
  html: string
): ReadonlyArray<HtmlTagDescriptor> =>
  RLY_PRELOADED_FONTS.map((font) => {
    const fileName = findFontAsset(bundle, font)
    if (fileName === undefined) throw new RlyFontPreloadMissingError({ font, html })
    return {
      attrs: { as: "font", crossorigin: "", href: `${base}${fileName}`, rel: "preload", type: "font/woff2" },
      injectTo: "head-prepend",
      tag: "link"
    }
  })

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
