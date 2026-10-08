import { expect, test } from "./fixtures.ts"

// Colour tokens are declared once on :root as light-dark(); a themed subtree only switches color-scheme.
// These pin that each subtree resolves its own value, so the per-theme re-declaration can't be needed.
test("resolves rly colours per themed subtree, nested either way", async ({ page }) => {
  await page.goto(
    "/iframe.html?id=foundations-icon--catalog&viewMode=story&globals=theme:dark;forcedColors:auto;reducedMotion:system;locale:en;density:comfortable"
  )
  await expect(page.getByRole("heading", { name: "Interface glyphs" })).toBeVisible()
  const colours = await page.evaluate(() => {
    const themed = document.querySelector("[data-theme='dark']")
    if (themed === null) return null
    const probe = (parent: Element, theme: string | null): string => {
      const box = document.createElement("div")
      if (theme !== null) box.setAttribute("data-theme", theme)
      const inner = document.createElement("div")
      inner.style.background = "var(--rly-color-canvas)"
      box.append(inner)
      parent.append(box)
      const value = getComputedStyle(inner).backgroundColor
      box.remove()
      return value
    }
    const dark = probe(themed, null)
    const lightInDark = probe(themed, "light")
    const lightBox = document.createElement("div")
    lightBox.setAttribute("data-theme", "light")
    themed.append(lightBox)
    const darkInLight = probe(lightBox, "dark")
    lightBox.remove()
    const forced = document.createElement("div")
    forced.setAttribute("data-forced-colors", "active")
    themed.append(forced)
    // The forced token is a system colour; system colours follow color-scheme, so compare the token itself.
    const themedInForcedBox = document.createElement("div")
    themedInForcedBox.setAttribute("data-theme", "light")
    forced.append(themedInForcedBox)
    const themedInForced = getComputedStyle(themedInForcedBox).getPropertyValue("--rly-color-canvas").trim()
    forced.remove()
    return { dark, darkInLight, lightInDark, themedInForced }
  })
  expect(colours).not.toBeNull()
  // Each scheme resolves its own canvas, whichever way the subtrees nest.
  expect(colours?.lightInDark).not.toBe(colours?.dark)
  expect(colours?.darkInLight).toBe(colours?.dark)
  // A themed subtree inside forced colours keeps the forced system colour, not a light-dark() value.
  expect(colours?.themedInForced).toBe("Canvas")
})
