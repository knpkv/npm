import { expect, type Page, test } from "@playwright/test"

/** Names of the animations running on the fixture agent's creature. */
const running = (page: Page): Promise<ReadonlyArray<string>> =>
  page
    .locator(".connect-agent svg.connect-creature")
    .first()
    .evaluate((svg) =>
      svg
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === "running")
        .map((animation) => ("animationName" in animation ? String(animation.animationName) : "?"))
        .sort()
    )

const open = async (page: Page, motion: "no-preference" | "reduce"): Promise<void> => {
  await page.emulateMedia({ reducedMotion: motion })
  await page.goto("/")
  await expect(page.locator(".connect-agent svg.connect-creature")).toHaveCount(1)
}

/**
 * Pause every animation on the fixture agent's creature: those whose names start with one of `names` at `share`
 * of an iteration, the rest at their start.
 */
const freeze = (page: Page, names: ReadonlyArray<string>, share: number): Promise<void> =>
  page
    .locator(".connect-agent svg.connect-creature")
    .first()
    .evaluate(
      (svg, [prefixes, at]) => {
        for (const animation of svg.getAnimations({ subtree: true })) {
          animation.pause()
          const timing = animation.effect?.getTiming()
          const name = "animationName" in animation ? String(animation.animationName) : ""
          const duration = Number(timing?.duration ?? 0)
          const delay = Number(timing?.delay ?? 0)
          // A negative delay is a head start; a negative current time is before the animation, so skip ahead
          // whole pairs of iterations, which keeps an alternating breath going the same way.
          const pairs = Math.ceil(-delay / duration / 2) * 2 * duration
          const fraction = prefixes.some((prefix) => name.startsWith(prefix)) ? at : 0.001
          animation.currentTime = fraction * duration + delay + pairs
        }
      },
      [names, share] satisfies readonly [ReadonlyArray<string>, number]
    )

/** The body's current scale and the first pupil's drawn size. */
const measure = (page: Page) =>
  page
    .locator(".connect-agent svg.connect-creature")
    .first()
    .evaluate((svg) => {
      const scales = [".connect-creature-breath", ".connect-creature-squash"].map((selector) => {
        const group = svg.querySelector(selector)
        return group === null ? "" : getComputedStyle(group).scale
      })
      const pupil = svg.querySelector(".connect-creature-pupil")?.getBoundingClientRect()
      return { body: scales.join(" / "), height: pupil?.height ?? 0, width: pupil?.width ?? 0 }
    })

test.describe("Connect creatures", () => {
  test("live while working when the reader allows motion", async ({ page }) => {
    await open(page, "no-preference")
    // Breathing, blinking, reading and the light round the body: the working agent's life. Each eye blinks with
    // three lid parts (the aperture's two edges and the lash) and reads with its own gaze.
    expect(await running(page)).toEqual([
      "connect-creature-blink",
      "connect-creature-blink",
      "connect-creature-blink",
      "connect-creature-blink",
      "connect-creature-blink-low",
      "connect-creature-blink-low",
      "connect-creature-bob",
      "connect-creature-breathe",
      "connect-creature-lash",
      "connect-creature-lash",
      "connect-creature-read",
      "connect-creature-read",
      "connect-creature-turn"
    ])
  })

  // Only the body squashes: through a breath and an arrival's hop the pupils stay round and keep their size.
  test("never squashes the eyes with the body", async ({ page }) => {
    await open(page, "no-preference")
    await freeze(page, [], 0)
    const rest = await measure(page)
    expect(rest.width).toBeGreaterThan(0)
    // The fixture agent is working; an arrival plays only when one starts needing you, so add its marker.
    await page
      .locator(".connect-agent svg.connect-creature")
      .first()
      .evaluate((svg) => svg.setAttribute("data-arrived", ""))
    const moments = [
      [["connect-creature-breathe", "connect-creature-bob"], 0.999],
      [["connect-creature-hop"], 0.14],
      [["connect-creature-hop"], 0.36],
      [["connect-creature-hop"], 0.56]
    ] satisfies ReadonlyArray<readonly [ReadonlyArray<string>, number]>
    for (const [names, share] of moments) {
      await freeze(page, names, share)
      const moment = await measure(page)
      expect(moment.body, names.join()).not.toBe(rest.body)
      expect(moment.width).toBeCloseTo(moment.height, 2)
      expect(moment.width).toBeCloseTo(rest.width, 2)
    }
  })

  // A shut eye must be the body's own skin: lids painted on top show as discs in another shade.
  test("closes its eyes onto unbroken skin", async ({ page }) => {
    await open(page, "no-preference")
    const svg = page.locator(".connect-agent svg.connect-creature").first()
    await svg.evaluate((node) =>
      node.setAttribute(
        "style",
        `${node.getAttribute("style") ?? ""};position:fixed;inset:0 auto auto 0;z-index:1;width:240px;height:240px`
      )
    )
    // A point on the eye's white beside the iris, clear of where the lash falls, read before the eyes go.
    const point = await svg.evaluate((node): readonly [number, number] => {
      const eye = node.querySelector(".connect-creature-white")
      const read = (name: string): number => Number(eye?.getAttribute(name) ?? 0)
      return [read("cx") - read("rx") * 0.8, read("cy") - read("ry") * 0.1]
    })
    expect(point[0]).toBeGreaterThan(0)
    /** The RGB drawn at that point. */
    const sample = async (): Promise<ReadonlyArray<number>> => {
      const shot = (await svg.screenshot()).toString("base64")
      return svg.evaluate(
        async (node, [png, [x, y]]) => {
          const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob())
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
          const context = canvas.getContext("2d")
          context?.drawImage(bitmap, 0, 0)
          const scale = bitmap.width / 100
          const pixel = context?.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data
          return [...(pixel ?? [])].slice(0, 3)
        },
        [shot, point] satisfies readonly [string, readonly [number, number]]
      )
    }
    const distance = (one: ReadonlyArray<number>, other: ReadonlyArray<number>) =>
      Math.max(...one.map((value, index) => Math.abs(value - (other[index] ?? 0))))
    await freeze(page, ["connect-creature-blink", "connect-creature-lash"], 0.958)
    const shut = await sample()
    await freeze(page, [], 0)
    const awake = await sample()
    // The skin under the eye: the same creature with its eyes taken away.
    await svg.evaluate((node) => {
      for (const eye of node.querySelectorAll(".connect-creature-eye")) eye.remove()
    })
    const skin = await sample()
    expect(distance(awake, skin)).toBeGreaterThan(60)
    expect(distance(shut, skin)).toBeLessThan(4)
  })

  test("still under the system reduced-motion preference", async ({ page }) => {
    await open(page, "reduce")
    expect(await running(page)).toEqual([])
  })

  // The hub's in-app setting zeroes rly's motion tokens; every pace is a multiple of one, so it stops too.
  test("still under the in-app reduced-motion setting", async ({ page }) => {
    await open(page, "no-preference")
    await page.evaluate(() => document.body.setAttribute("data-rly-reduced-motion", "reduce"))
    await expect.poll(() => running(page)).toEqual([])
  })

  test("keeps its outline and eyes in forced colours", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" })
    await page.goto("/")
    const creature = page.locator(".connect-agent svg.connect-creature").first()
    await expect(creature).toBeVisible()
    const drawn = await creature.evaluate((svg) => ({
      body: getComputedStyle(svg.querySelector(".connect-creature-body") ?? svg).stroke,
      pupil: getComputedStyle(svg.querySelector(".connect-creature-pupil") ?? svg).fill
    }))
    expect(drawn.body).not.toBe("none")
    expect(drawn.pupil).not.toBe("none")
  })
})
