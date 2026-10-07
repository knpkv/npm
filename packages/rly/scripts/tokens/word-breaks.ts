/**
 * Detects CSS that splits words: `overflow-wrap: anywhere` and `word-break: break-all` (or the
 * legacy `break-word`). They let a flex or grid track shrink below a word's width, so "Installed"
 * renders as "Installe / d". Use `overflow-wrap: break-word`, which breaks only a token (hash, URL,
 * branch) that cannot fit, inside a bounded track (`min-inline-size: 0`, `minmax(0, 1fr)`).
 */
import type { AccentStripeViolation } from "./accent-stripes.js"

const SPLITS_WORDS = /(?<![\w-])(overflow-wrap\s*:\s*anywhere|word-break\s*:\s*break-(?:all|word))\b/gi

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))

/** Every declaration that splits words, with its 1-based position. */
export const findWordSplits = (path: string, source: string): ReadonlyArray<AccentStripeViolation> =>
  [...stripComments(source).matchAll(SPLITS_WORDS)].map((match) => {
    const lines = source.slice(0, match.index).split("\n")
    return {
      column: (lines.at(-1)?.length ?? 0) + 1,
      declaration: (match[1] ?? "").replace(/\s+/g, " ").replace(/\s*:\s*/, ": "),
      line: lines.length,
      path
    }
  })
