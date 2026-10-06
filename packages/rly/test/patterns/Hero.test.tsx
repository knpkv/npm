// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Hero, HeroWord, RLY_HERO_VARIANTS, RLY_HERO_WORD_VARIANTS } from "../../src/patterns/Hero.js"

describe("Hero", () => {
  it("is a named summary with the fact and its caption as separate paragraphs", () => {
    const markup = renderToStaticMarkup(<Hero caption="Oldest 2d." fact="4 PRs wait on you" />)
    expect(markup).toContain('aria-label="Summary"')
    expect(markup).toContain(RLY_HERO_VARIANTS.size.heading.className)
    expect(markup).toMatch(/<p[^>]*>4 PRs wait on you<\/p><p[^>]*>Oldest 2d\.<\/p>/)
  })

  it("folds to one paragraph in the line size, fact first", () => {
    const markup = renderToStaticMarkup(
      <Hero caption="Oldest 2d." fact="4 PRs wait" label="Queue summary" size="line" />
    )
    expect(markup).toContain('aria-label="Queue summary"')
    expect(markup.match(/<p/g)).toHaveLength(1)
    expect(markup).toMatch(/<strong[^>]*>4 PRs wait<\/strong> <span[^>]*>Oldest 2d\.<\/span>/)
  })

  it("leaves the caption out when none is given", () => {
    expect(renderToStaticMarkup(<Hero fact="Clear" />).match(/<p/g)).toHaveLength(1)
  })

  it("inks only the state word", () => {
    const markup = renderToStaticMarkup(
      <Hero
        fact={
          <>
            Relay is <HeroWord tone="blocked">blocked</HeroWord>
          </>
        }
      />
    )
    expect(markup).toContain(RLY_HERO_WORD_VARIANTS.tone.blocked.className)
    expect(markup).toContain("Relay is <span")
  })
})
