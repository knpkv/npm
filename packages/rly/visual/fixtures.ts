import { expect, test as base } from "@playwright/test"

/**
 * rly loads Geist with `font-display: optional`. A font that arrives after the block period renders the
 * fallback, and Chromium may still switch to Geist on a later relayout (emulating forced colours, for
 * one), so a width measured before and after that relayout differs. Visual specs import `test` from here,
 * which serves rly's CSS with `font-display: block` so every measurement is in Geist. Only
 * font-swap.spec.ts imports Playwright directly, because it measures the real optional behaviour.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route(/\.css(?:[?#].*)?$/, async (route) => {
      const response = await route.fetch()
      const body = (await response.text()).replace(/font-display:\s*optional/g, "font-display: block")
      await route.fulfill({ body, response })
    })
    await use(page)
  }
})

export { expect }
