import { expect, type Locator, type Page, test } from "@playwright/test"

const open = async (page: Page, size = "stage", pixels = "144", family = "rose", extra = "") => {
  await page.goto(
    `/?drawing&host=build-01&id=agent-builder-alpha&state=idle&taskKind=idle&size=${size}&pixels=${pixels}&family=${family}${extra}`
  )
  const svg = page.locator("[data-drawing-case] > svg.connect-creature").first()
  await expect(svg).toHaveAttribute("data-idle-motion", "")
  return svg
}

const timing = (node: Locator) =>
  node.evaluate((element) => ({
    name: getComputedStyle(element).animationName,
    duration: Number.parseFloat(getComputedStyle(element).animationDuration) * 1000,
    delay: Number.parseFloat(getComputedStyle(element).animationDelay) * 1000
  }))

const themes: ReadonlyArray<"light" | "dark"> = ["light", "dark"]
const frames: ReadonlyArray<readonly [string, string]> = [["stage", "144"], ["row", "40"], ["row", "28"], [
  "cast",
  "60"
]]
const habits: ReadonlyArray<readonly [string, string]> = [["rose", "flick"], ["ember", "hop"], ["amber", "squint"], [
  "lime",
  "tilt"
]]

for (const theme of themes) {
  test.describe(`idle signature ${theme}`, () => {
    test.use({ colorScheme: theme, reducedMotion: "no-preference" })

    // Page15 idle clocks, scaled by page17 literal builder-alpha tempo0.95 and phase198/256.
    for (const [size, pixels] of frames) {
      test(`idle ${size} ${pixels} keeps the reference clocks and seeded phase`, async ({ page }) => {
        const svg = await open(page, size, pixels)
        expect(await svg.evaluate((node) => node.getBoundingClientRect().width)).toBe(Number(pixels))
        const blink = await timing(svg.locator(".connect-creature-idle-blink"))
        expect(blink.name).toBe("connect-creature-idle-blink")
        expect(blink.duration).toBeCloseTo(15000 * 0.95, 1)
        expect(blink.delay).toBeCloseTo(-Math.round(13000 * 198 / 256), 1)
        const fidget = await timing(svg.locator(".connect-creature-idle-fidget"))
        expect(fidget.name).toBe(size === "stage" ? "connect-creature-idle-fidget" : "connect-creature-idle-tilt")
        expect(fidget.duration).toBeCloseTo(13000 * 0.95, 1)
        const breath = await timing(svg.locator(".connect-creature-idle-breath"))
        expect(breath.name).toBe(size === "stage" ? "connect-creature-idle-breath" : "none")
        if (size === "stage") expect(breath.duration).toBeCloseTo(4200 * 0.95, 1)
        await expect(svg.locator(".connect-creature-mouth")).toHaveCount(0)
      })
    }

    // Page15's draw() paints a lit upper lid and a thin lash, even in the settled frame.
    for (const [size, pixels] of [["stage", "144"], ["row", "40"]]) {
      test(`idle reference paint has lit lids and a thin lash ${size}`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" })
        const svg = await open(page, size, pixels, "ember")
        const face = svg.locator(".connect-creature-idle-open-face")
        await expect(face.locator(".connect-creature-idle-lid-fill")).toHaveCount(2)
        const unit = await svg.evaluate((node) => Number(node.style.getPropertyValue("--connect-creature-unit")))
        const fills = await face.locator(".connect-creature-idle-lid-fill").evaluateAll((nodes) =>
          nodes.map((node) => getComputedStyle(node).fill)
        )
        expect(fills).toEqual(["rgb(197, 95, 29)", "rgb(197, 95, 29)"])
        const widths = await face.locator(".connect-creature-lash").evaluateAll((nodes) =>
          nodes.map((node) => Number.parseFloat(getComputedStyle(node).strokeWidth))
        )
        expect(widths).toHaveLength(2)
        for (const width of widths) expect(width / unit).toBeCloseTo(size === "stage" ? 0.45 : 0.9, 4)
      })
    }

    // draw() clips iris + painted lid inside the true eye, without separately cutting the white.
    // Its upper edge spans ew+0.5 per side, 5.25 total units, and its brows are 90% ink.
    for (const [size, pixels] of [["stage", "144"], ["row", "40"]]) {
      test(`idle settled eye uses the reference clip and edge geometry ${size}`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" })
        const svg = await open(page, size, pixels, "ember")
        const face = svg.locator(".connect-creature-idle-open-face")
        const spans = await face.locator(".connect-creature-lash").evaluateAll((nodes) =>
          nodes.map((node) => {
            const path = node.closest("path")
            if (path === null) return null
            const unit = Number(path.ownerSVGElement?.style.getPropertyValue("--connect-creature-unit"))
            return (path.getPointAtLength(path.getTotalLength()).x - path.getPointAtLength(0).x) / unit
          })
        )
        expect(spans).toHaveLength(2)
        for (const span of spans) expect(span).toBeCloseTo(5.25, 3)
        await expect(face.locator("[clip-path*=\"-upper-\"] .connect-creature-white")).toHaveCount(0)
        await expect(face.locator("[clip-path*=\"-lower-\"] .connect-creature-white")).toHaveCount(0)
        const opacity = await face.locator(".connect-creature-brow").evaluateAll((nodes) =>
          nodes.map((node) => Number(getComputedStyle(node).opacity))
        )
        expect(opacity).toEqual([0.9, 0.9])
      })
    }

    // Page18 drawFc: 1.2-unit body, 0.8-unit ellipse eyes and a single solid 1.2-unit pupil.
    test("idle reference paint uses the plain forced-colour face and outline", async ({ page }) => {
      for (const boundary of ["system", "in-app"]) {
        await page.emulateMedia({ forcedColors: boundary === "system" ? "active" : "none" })
        const svg = await open(page, "stage", "144", "ember")
        if (boundary === "in-app") {
          await page.locator("html").evaluate((node) => node.setAttribute("data-rly-forced-colors", "active"))
        }
        const unit = await svg.evaluate((node) => Number(node.style.getPropertyValue("--connect-creature-unit")))
        const width = await svg.locator(".connect-creature-body").evaluate((node) =>
          Number.parseFloat(getComputedStyle(node).strokeWidth)
        )
        expect(width / unit, boundary).toBeCloseTo(1.2, 4)
        const face = svg.locator(".connect-creature-idle-forced-face")
        await expect(face).toHaveCSS("display", "inline")
        await expect(face.locator("ellipse")).toHaveCount(2)
        await expect(face.locator("circle")).toHaveCount(2)
        const radii = await face.locator("circle").evaluateAll((nodes) =>
          nodes.map((node) => Number(node.getAttribute("r")))
        )
        for (const radius of radii) expect(radius / unit).toBeCloseTo(1.2, 4)
        await expect(svg.locator(".connect-creature-idle-base-face")).toHaveCSS("display", "none")
        expect(await svg.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0)
      }
    })

    // Page15/17 wrap the whole draw result, including its ground shadow, in the task and habit layers.
    test("idle reference paint moves the shadow with the body at inhale", async ({ page }) => {
      const svg = await open(page, "stage", "144", "ember")
      await expect(svg).toHaveAttribute("data-motion-visible", "")
      // Positive common-period equivalent of the requested 50% breath, all other clocks unchanged.
      await svg.evaluate((node) => {
        for (const animation of node.getAnimations({ subtree: true })) {
          animation.pause()
          animation.currentTime = 10_373_920
        }
      })
      const matrices = await svg.evaluate((node) => {
        const body = node.querySelector(".connect-creature-body")?.closest("path")
        const shadow = node.querySelector(".connect-creature-shadow")?.closest("ellipse")
        const b = body?.getScreenCTM()
        const s = shadow?.getScreenCTM()
        if (b === undefined || b === null || s === undefined || s === null) return null
        return { body: [b.a, b.b, b.c, b.d, b.e, b.f], shadow: [s.a, s.b, s.c, s.d, s.e, s.f] }
      })
      expect(matrices).not.toBeNull()
      expect(matrices?.body).toEqual(matrices?.shadow)
    })

    // Pages15/17 creature(): the base full frame remains below each full blink/squint frame.
    // draw() includes a 16% shadow in every frame, so two overlap to29.44%, three to40.7296%.
    for (const [size, pixels] of [["stage", "144"], ["row", "40"]]) {
      test(`idle ground shadow follows complete pose-frame composition ${size}`, async ({ page }) => {
        const svg = await open(page, size, pixels, "amber")
        await expect(svg).toHaveAttribute("data-motion-visible", "")
        const samples: ReadonlyArray<readonly [number, number]> = [
          [10_373_920, 1],
          [18_473.5, 2],
          [12_660, 2],
          [103_995, 3]
        ]
        for (const [time, count] of samples) {
          const paint = await svg.evaluate((node, time) => {
            for (const animation of node.getAnimations({ subtree: true })) {
              animation.pause()
              animation.currentTime = time
            }
            const body = node.querySelector(".connect-creature-body")?.closest("path")?.getScreenCTM()
            const shadows = [...node.querySelectorAll(".connect-creature-shadow")].map((element) => {
              let opacity = 1
              for (let parent: Element | null = element; parent !== null; parent = parent.parentElement) {
                const style = getComputedStyle(parent)
                opacity *= style.display === "none" ? 0 : Number(style.opacity)
                if (parent === node) break
              }
              const matrix = element.closest("ellipse")?.getScreenCTM()
              return {
                opacity: opacity * Number(getComputedStyle(element).fillOpacity),
                sameMatrix: body !== undefined && body !== null && matrix !== undefined && matrix !== null &&
                  [body.a, body.b, body.c, body.d, body.e, body.f].every((value, index) =>
                    value === [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f][index]
                  )
              }
            })
            return {
              visible: shadows.filter(({ opacity }) => opacity > 0).length,
              alpha: 1 - shadows.reduce((transmission, { opacity }) => transmission * (1 - opacity), 1),
              sameMatrix: shadows.every(({ sameMatrix }) => sameMatrix)
            }
          }, time)
          expect(paint.visible, `frame at ${String(time)}ms`).toBe(count)
          expect(paint.alpha).toBeCloseTo(1 - 0.84 ** count, 6)
          expect(paint.sameMatrix).toBe(true)
        }
        await page.emulateMedia({ reducedMotion: "reduce" })
        const visible = await svg.locator(".connect-creature-shadow").evaluateAll((nodes) =>
          nodes.filter((node) =>
            getComputedStyle(node).display !== "none" && Number(getComputedStyle(node).opacity) > 0
          ).length
        )
        expect(visible).toBe(1)
      })
    }

    test("idle blink paints the reference shut lash without eye whites", async ({ page }) => {
      const svg = await open(page)
      const blink = svg.locator(".connect-creature-idle-blink")
      await expect(blink).toHaveCount(1)
      await expect(blink.locator(".connect-creature-white")).toHaveCount(0)
      await expect(blink.locator(".connect-creature-lash[data-shut]")).toHaveCount(2)
      // Page15 cm-blink15 is a full closed-eye frame, cross-faded with linear timing.
      await expect(blink).toHaveCSS("animation-timing-function", "linear")
    })

    // Page17 byte3=213 plus actual rendered family index selects flick/hop/squint/tilt.
    for (const [family, habit] of habits) {
      test(`idle ${habit} habit uses its own eight-second wrapper`, async ({ page }) => {
        const svg = await open(page, "stage", "144", family)
        await expect(svg).toHaveAttribute("data-idle-habit", habit)
        const animated = habit === "squint"
          ? svg.locator(".connect-creature-idle-squint")
          : svg.locator(".connect-creature-idle-habit")
        const read = await timing(animated)
        expect(read.name).toBe(`connect-creature-habit-${habit}`)
        expect(read.duration).toBeCloseTo(8000 * 0.95, 1)
        expect(read.delay).toBeCloseTo(-Math.round(8000 * 198 / 256), 1)
        expect(await svg.locator(".connect-creature-body").getAttribute("d")).toBeTruthy()
      })
    }

    test("same-kind refresh retains body, face and animation lifetime", async ({ page }) => {
      const svg = await open(page)
      await svg.locator(".connect-creature-body").evaluate((node) => node.setAttribute("data-retained", "yes"))
      await svg.locator(".connect-creature-idle-open-face .connect-creature-face").evaluate((node) =>
        node.setAttribute("data-retained", "yes")
      )
      await svg.locator(".connect-creature-lean").evaluate((node) => node.setAttribute("data-retained", "yes"))
      await expect.poll(() =>
        svg.evaluate((node) => node.getAnimations({ subtree: true }).every((animation) => animation.startTime !== null))
      ).toBe(true)
      const animations = await svg.evaluate((node) =>
        node.getAnimations({ subtree: true }).map((animation, index) => {
          animation.id = `retained-${String(index)}`
          return { id: animation.id, startTime: animation.startTime, currentTime: Number(animation.currentTime) }
        })
      )
      expect(animations.length).toBeGreaterThan(0)
      await page.getByRole("button", { name: "Replay reaction" }).click()
      // Page16: updating state words within the same idle kind must not restart a loop.
      for (const state of ["ready", "idle"]) {
        await page.getByRole("combobox", { name: "Agent state" }).selectOption(state)
        for (
          const part of [
            ".connect-creature-body",
            ".connect-creature-lean",
            ".connect-creature-idle-open-face .connect-creature-face"
          ]
        ) {
          await expect(svg.locator(part)).toHaveAttribute("data-retained", "yes")
        }
        const retained = await svg.evaluate((node) =>
          node.getAnimations({ subtree: true }).map((animation) => ({
            id: animation.id,
            startTime: animation.startTime,
            currentTime: Number(animation.currentTime)
          }))
        )
        expect(retained.map(({ id, startTime }) => ({ id, startTime }))).toEqual(
          animations.map(({ id, startTime }) => ({ id, startTime }))
        )
        expect(retained.every((animation, index) => animation.currentTime >= (animations[index]?.currentTime ?? 0)))
          .toBe(true)
      }
      await page.getByRole("combobox", { name: "Task kind" }).selectOption("waiting")
      await expect(svg).not.toHaveAttribute("data-idle-motion")
      expect(await svg.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0)
    })

    test("visible idle neighbours shift only the second near-synchronous phase", async ({ page }) => {
      await page.goto("/?drawing&neighbours&host=build-01&state=idle&taskKind=idle&size=row&pixels=40&family=rose")
      const roots = page.locator("[data-drawing-case] > svg.connect-creature")
      await expect(roots).toHaveCount(2)
      await expect(roots.nth(0)).toHaveAttribute("data-idle-phase", "0.875")
      expect(Number(await roots.nth(1).getAttribute("data-idle-phase"))).toBeCloseTo((0.875 + 1 / 3) % 1, 8)
      const delays = await roots.evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).getPropertyValue("--connect-creature-idle-phase"))
      )
      expect(delays).toEqual(["-11375ms", "-2708ms"])
    })

    test("offscreen idle pauses and visible idle resumes", async ({ page }) => {
      const svg = await open(page, "stage", "144", "rose", "&accessory=glasses")
      await expect(svg.locator(".connect-creature-accessory")).toHaveCount(1)
      await expect.poll(() =>
        svg.evaluate((node) =>
          node.getAnimations({ subtree: true }).some((animation) => animation.playState === "running")
        )
      ).toBe(true)
      const animationIds = await svg.evaluate((node) =>
        node.getAnimations({ subtree: true }).map((animation, index) => {
          animation.id = `visible-${String(index)}`
          return animation.id
        })
      )
      await svg.evaluate((node) => node.parentElement?.style.setProperty("margin-block-start", "200vh"))
      await expect.poll(() =>
        svg.evaluate((node) =>
          node.getAnimations({ subtree: true }).every((animation) => animation.playState === "paused")
        )
      ).toBe(true)
      await expect(svg.locator(".connect-creature-accessory")).toHaveCSS("animation-name", "none")
      await svg.scrollIntoViewIfNeeded()
      await expect.poll(() =>
        svg.evaluate((node) =>
          node.getAnimations({ subtree: true }).some((animation) => animation.playState === "running")
        )
      ).toBe(true)
      expect(await svg.evaluate((node) => node.getAnimations({ subtree: true }).map((animation) => animation.id)))
        .toEqual(animationIds)
    })

    test("legacy sleepy accessory motion remains without idle task evidence", async ({ page }) => {
      await page.goto("/?drawing&state=idle&size=stage&accessory=glasses")
      const svg = page.locator("[data-drawing-case] > svg.connect-creature")
      await expect(svg).not.toHaveAttribute("data-idle-motion")
      await expect(svg.locator(".connect-creature-accessory")).toHaveCSS(
        "animation-name",
        "connect-creature-accessory-sleep"
      )
    })

    test("non-idle poke replay still replaces the stage animation owner", async ({ page }) => {
      await page.goto("/?drawing&state=idle&size=stage&reaction=poke&talking")
      const lean = page.locator("[data-drawing-case] .connect-creature-lean")
      await lean.evaluate((node) => node.setAttribute("data-retained", "yes"))
      await page.getByRole("button", { name: "Replay reaction" }).click()
      await expect(lean).not.toHaveAttribute("data-retained")
      expect(await lean.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBeGreaterThan(0)
    })

    for (const boundary of ["system", "in-app", "forced-colours", "closed", "stale"]) {
      test(`idle stays settled under ${boundary}`, async ({ page }) => {
        if (boundary === "system") await page.emulateMedia({ reducedMotion: "reduce" })
        if (boundary === "forced-colours") await page.emulateMedia({ forcedColors: "active" })
        await page.goto(
          `/?drawing&state=idle&taskKind=idle&size=stage&${
            boundary === "closed" ? "closed" : boundary === "stale" ? "stale" : ""
          }`
        )
        const svg = page.locator("[data-drawing-case] > svg.connect-creature").first()
        if (boundary === "in-app") {
          await page.locator("html").evaluate((node) => node.setAttribute("data-rly-reduced-motion", "reduce"))
        }
        expect(await svg.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0)
      })
    }

    test("a 256-agent idle directory shares one visibility observer and bounded animation work", async ({ page }) => {
      await page.addInitScript(() => {
        const Native = IntersectionObserver
        window.IntersectionObserver = class extends Native {
          constructor(...args: ConstructorParameters<typeof IntersectionObserver>) {
            super(...args)
            const root = document.documentElement
            root.dataset.idleObservers = String(Number(root.dataset.idleObservers ?? "0") + 1)
          }
        }
      })
      await page.goto("/?drawing=grid&state=idle&taskKind=idle&size=row&pixels=28&count=256&accessory=glasses")
      const roots = page.locator("[data-drawing-case] > svg.connect-creature")
      await expect(roots).toHaveCount(256)
      await expect(page.locator("html")).toHaveAttribute("data-idle-observers", "1")
      const costs = await roots.evaluateAll((nodes) =>
        nodes.map((node) => ({
          count: node.getAnimations({ subtree: true }).length,
          active: node.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length
        }))
      )
      expect(costs.every(({ count }) => count <= 8)).toBe(true)
      expect(costs.filter(({ active }) => active > 0).length).toBeLessThan(40)
    })
  })
}
