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
        expect((await launcher.boundingBox())?.height).toBe(44)
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
          const drawing = mark.locator(
            `[data-relay-chef-drawing=contrast][data-relay-chef-size="${info.project.name === "phone" ? "24" : "32"}"]`
          )
          await expect(mark.locator("[data-relay-chef-drawing=mark]:visible")).toHaveCount(0)
          await expect(drawing).toBeVisible()
          const outline = await drawing.locator(":scope > g > path").first().evaluate((node) => ({
            color: getComputedStyle(node).color,
            stroke: getComputedStyle(node).stroke,
            fill: getComputedStyle(node).fill
          }))
          expect(outline.stroke).toBe(outline.color)
          expect(outline.fill).toBe("none")
          const pupils = await drawing.locator("circle[fill=\"currentColor\"]").all()
          expect(pupils.length).toBeGreaterThan(0)
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

test("switches pixel-sized drawings at the same breakpoint as the mark size", async ({ page }) => {
  await page.goto("/")
  const header = page.locator(".superapp-header .relay-chef-mark")
  const sidebar = page.locator(".superapp-sidebar .relay-chef-mark")
  for (const width of [639, 641]) {
    await page.setViewportSize({ width, height: 900 })
    const launcherSize = width === 639 ? 24 : 32
    // Installed chrome has a Home brand mark plus the single Ask Relay launcher.
    const visibleMarks = header.filter({ visible: true })
    expect(await visibleMarks.count()).toBeGreaterThan(0)
    for (const mark of await visibleMarks.all()) {
      const brand = await mark.evaluate((node) => node.closest(".superapp-brand") !== null)
      const size = brand ? 28 : launcherSize
      await expect(mark.locator("[data-relay-chef-drawing=\"mark\"]:visible")).toHaveCount(1)
      await expect(mark.locator("[data-relay-chef-drawing=\"mark\"]:visible")).toHaveAttribute(
        "data-relay-chef-size",
        String(size)
      )
      expect((await mark.boundingBox())?.width).toBe(size)
    }
    // The hidden phone sidebar still owns the 32px drawing; it never switches to phone art.
    const sidebarDrawing = await sidebar.locator("[data-relay-chef-drawing=\"mark\"][data-relay-chef-size=\"32\"]")
      .evaluate((node) => getComputedStyle(node).display)
    expect(sidebarDrawing).toBe("inline")
    for (const drawing of await sidebar.locator("[data-relay-chef-size=\"24\"]").all()) {
      await expect(drawing).toHaveCSS("display", "none")
    }
  }
})

/** Shared mast target geometry applies outside Code too; glyph size does not shrink its hit area. */
test("shared mast keeps centred brand and full-sized controls", async ({ page }, info) => {
  await page.goto("/?relayFixture=idle#fleet/work")
  const header = page.locator(".superapp-header")
  const controls = await header.evaluate((root) => {
    const box = (node: Element) => {
      const rect = node.getBoundingClientRect()
      return { x: rect.x, width: rect.width, height: rect.height }
    }
    const brand = root.querySelector(".superapp-brand")
    const mark = brand?.querySelector("svg")
    const ask = root.querySelector("[data-rly-relay-launcher]")
    const bell = root.querySelector(".superapp-notifications")
    const bellIcon = bell?.querySelector("svg")
    if (
      brand === null || mark === undefined || mark === null || ask === null || bell === null ||
      bellIcon === undefined || bellIcon === null
    ) throw new Error("Missing shared mast control")
    const style = getComputedStyle(ask)
    return {
      brand: box(brand),
      mark: box(mark),
      ask: box(ask),
      bell: box(bell),
      bellIcon: box(bellIcon),
      size: style.fontSize,
      weight: style.fontWeight,
      padding: style.paddingInlineStart,
      markSize: mark.querySelector("[data-relay-chef-drawing=mark]")?.getAttribute("data-relay-chef-size")
    }
  })
  expect(controls.ask.height).toBe(44)
  expect(controls.bell.height).toBe(44)
  expect(controls.bell.width).toBe(44)
  expect(controls.bellIcon.width).toBe(19)
  expect(controls.size).toBe("14px")
  expect(controls.weight).toBe("520")
  expect(controls.padding).toBe("8px")
  if (info.project.name === "desktop") {
    const hint = header.locator("kbd")
    await expect(hint).toBeVisible()
    await expect(hint).toHaveCSS("border-start-start-radius", "4px")
  }
  if (info.project.name === "phone") {
    expect(controls.brand).toMatchObject({ x: 8, width: 44, height: 44 })
    expect(controls.mark).toMatchObject({ x: 16, width: 28, height: 28 })
    expect(controls.markSize).toBe("28")
    expect(controls.bell.x).toBe(214)
    expect(controls.ask).toMatchObject({ x: 258, width: 116 })
  }
})
