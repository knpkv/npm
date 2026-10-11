import { expect, test } from "@playwright/test"

for (
  const contrast of ["none", "media", "attribute", "rly-attribute"] satisfies ReadonlyArray<
    "none" | "media" | "attribute" | "rly-attribute"
  >
) {
  test(
    `keeps the Chef square and the existing launcher size closed/open with ${contrast} contrast`,
    async ({ page }, info) => {
      await page.emulateMedia({
        forcedColors: contrast === "media" ? "active" : "none",
        reducedMotion: contrast === "none" ? "no-preference" : "reduce"
      })
      await page.goto("/?relayFixture=turns")
      if (contrast === "attribute" || contrast === "rly-attribute") {
        await page.evaluate((kind) =>
          document.documentElement.setAttribute(
            kind === "attribute" ? "data-forced-colors" : "data-rly-forced-colors",
            "active"
          ), contrast)
      }
      // The phone conversation isolates the header from assistive technology while open.
      const launcher = page.getByRole("button", { name: "Ask Relay", exact: true, includeHidden: true })
      const mark = launcher.locator("svg.relay-chef-mark")
      const header = page.locator(".superapp-header")
      const initialHeaderHeight = (await header.boundingBox())?.height
      if (initialHeaderHeight === undefined) throw new Error("Header missing")
      for (const expanded of [false, true]) {
        if (expanded) await launcher.click()
        await expect(launcher).toHaveAttribute("aria-expanded", String(expanded))
        await expect(launcher).toHaveAttribute("aria-label", "Ask Relay")
        await expect(launcher).toHaveAccessibleName(expanded && info.project.name === "phone" ? "" : "Ask Relay")
        await expect(mark).toHaveAttribute("aria-hidden", "true")
        await expect(mark).toHaveAttribute("focusable", "false")
        await expect(mark.locator("title,desc")).toHaveCount(0)
        const dimensions = await mark.evaluate((svg) => ({
          width: svg.getBoundingClientRect().width,
          height: svg.getBoundingClientRect().height,
          viewBox: svg.getAttribute("viewBox"),
          animations: svg.getAnimations({ subtree: true }).length
        }))
        expect(dimensions.viewBox).toBe("0 0 32 32")
        expect(dimensions.width).toBe(info.project.name === "phone" ? 24 : 32)
        expect(dimensions.height).toBe(dimensions.width)
        expect(dimensions.animations).toBe(0)
        expect((await launcher.boundingBox())?.height).toBe(info.project.name === "phone" ? 44 : 32)
        const padding = await launcher.evaluate((button) => {
          const box = button.getBoundingClientRect()
          const style = getComputedStyle(button)
          return {
            start: box.left + parseFloat(style.borderLeftWidth),
            end: box.right - parseFloat(style.borderRightWidth),
            top: box.top + parseFloat(style.borderTopWidth),
            bottom: box.bottom - parseFloat(style.borderBottomWidth)
          }
        })
        const bounds = await mark.boundingBox()
        if (bounds === null) throw new Error("Chef mark missing")
        expect(bounds.x).toBeGreaterThanOrEqual(padding.start)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(padding.end)
        expect(bounds.y).toBeGreaterThanOrEqual(padding.top)
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(padding.bottom)
        expect((await header.boundingBox())?.height).toBeLessThanOrEqual(initialHeaderHeight)
        if (contrast !== "none") {
          await expect(mark.locator("[data-relay-chef-drawing=mark]")).toHaveCSS("display", "none")
          const outline = await mark.locator("[data-relay-chef-drawing=contrast] > path").first().evaluate((node) => ({
            color: getComputedStyle(node).color,
            stroke: getComputedStyle(node).stroke,
            fill: getComputedStyle(node).fill
          }))
          expect(outline.stroke).toBe(outline.color)
          expect(outline.fill).toBe("none")
          const pupils = await mark.locator("[data-relay-chef-drawing=contrast] circle[fill]").all()
          for (const pupil of pupils) {
            expect(await pupil.evaluate((node) => getComputedStyle(node).fill)).toBe(outline.color)
          }
        }
      }
      await expect(page.locator("[data-rly-relay-launcher]")).toHaveCount(1)
      await expect(page.locator("[data-rly-relay-panel] .connect-creature")).toHaveCount(4)
      await page.getByRole("button", { name: "Close Relay", exact: true }).click()
      await expect(page.locator("[data-rly-relay-panel]")).toHaveCount(0)
    }
  )
}

test("paints the visible Chef's plum body even with the other mark hidden in the sidebar", async ({ page }) => {
  await page.goto("/")
  const mark = page.locator("[data-rly-relay-launcher] svg.relay-chef-mark")
  const image = await mark.screenshot()
  const pixel = await page.evaluate(async (base64) => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext("2d")
    if (context === null) throw new Error("Canvas unavailable")
    context.drawImage(image, 0, 0)
    return [...context.getImageData(Math.floor(image.width / 2), Math.floor(image.height * 0.85), 1, 1).data]
  }, image.toString("base64"))
  const [red, green, blue, alpha] = pixel
  expect(alpha).toBe(255)
  expect(red).toBeGreaterThan((green ?? 255) * 1.3)
  expect(blue).toBeGreaterThan((green ?? 255) * 1.3)
})

test("serves the simplified favicon separately and keeps full-bleed PNG corners opaque", async ({ page }) => {
  await page.goto("/")
  await expect(page.locator("link[rel=\"icon\"]")).toHaveAttribute("href", "/assets/relay-favicon.svg")
  const favicon = await page.request.get("/assets/relay-favicon.svg")
  const app = await page.request.get("/assets/relay-icon.svg")
  expect(favicon.status()).toBe(200)
  expect(await favicon.text()).toContain("width=\"16\" height=\"16\"")
  expect(await app.text()).toContain("viewBox=\"0 0 512 512\"")
  const corners = await page.evaluate(async () => {
    const readings = []
    for (const name of ["relay-maskable-512.png", "relay-apple-touch-180.png"]) {
      const image = new Image()
      image.src = `/assets/${name}`
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext("2d")
      if (context === null) throw new Error("Canvas unavailable")
      context.drawImage(image, 0, 0)
      readings.push(
        [0, image.width - 1].flatMap((x) => [0, image.height - 1].map((y) => context.getImageData(x, y, 1, 1).data[3]))
      )
    }
    return readings
  })
  expect(corners).toEqual([[255, 255, 255, 255], [255, 255, 255, 255]])
})
