import { expect, type Page, test } from "@playwright/test"
import { agentStatePresentation } from "../../src/agent-state.js"

/** The actual SVG paths for the contact-sheet seeds, under the app's creature stylesheet. */
const openBrowGrid = async (page: Page): Promise<void> => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/?brows")
  await expect(page.locator("[data-brow-grid] svg.connect-creature")).toHaveCount(64)
}

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

/** The body's current scale and the first pupil's and brow's drawn sizes. */
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
      const brow = svg.querySelector(".connect-creature-brow")?.getBoundingClientRect()
      return {
        body: scales.join(" / "),
        height: pupil?.height ?? 0,
        width: pupil?.width ?? 0,
        browWidth: brow?.width ?? 0,
        browHeight: brow?.height ?? 0
      }
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
    expect(rest.browWidth).toBeGreaterThan(0)
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
      expect(moment.browWidth).toBeCloseTo(rest.browWidth, 2)
      expect(moment.browHeight).toBeCloseTo(rest.browHeight, 2)
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

  for (const size of ["row", "cast", "stage"]) {
    for (const state of ["ready", "working", "needs-you", "finished", "stale"]) {
      test(`${size} brows clear sockets, silhouette and centre line across 64 seeds while ${state}`, async ({ page }) => {
        test.setTimeout(30_000)
        await openBrowGrid(page)
        const failures = await page.locator("[data-brow-grid]").evaluate((grid, [drawnSize, shown]) => {
          const failures: Array<string> = []
          for (const [index, svg] of [...grid.querySelectorAll<SVGSVGElement>("svg")].entries()) {
            svg.setAttribute("data-size", drawnSize)
            svg.setAttribute("data-bucket", shown === "stale" ? "working" : shown)
            if (shown === "stale") svg.setAttribute("data-stale", "")
            for (const animation of svg.getAnimations({ subtree: true })) {
              animation.pause()
              const timing = animation.effect?.getTiming()
              const duration = Number(timing?.duration ?? 0)
              const delay = Number(timing?.delay ?? 0)
              const name = "animationName" in animation ? String(animation.animationName) : ""
              if (duration > 0) {
                animation.currentTime = delay + Math.ceil(-delay / duration / 2) * 2 * duration
                  + duration * (name === "connect-creature-brow-lift" ? 0.2 : 0.001)
              }
            }
            const body = svg.querySelector<SVGPathElement>(".connect-creature-body")
            const bob = svg.querySelector<SVGGElement>(".connect-creature-bob")
            const brows = [...svg.querySelectorAll<SVGPathElement>(".connect-creature-brow")]
            const sockets = [...svg.querySelectorAll<SVGEllipseElement>(".connect-creature-socket")]
            const bodyInverse = body?.getCTM()?.inverse()
            const bobInverse = bob?.getCTM()?.inverse()
            if (
              body === null || bodyInverse === undefined || bobInverse === undefined || brows.length !== 2 ||
              sockets.length !== 2
            ) {
              failures.push(`Seed ${index}: incomplete face`)
              continue
            }
            for (const [side, brow] of brows.entries()) {
              const matrix = brow.getCTM()
              const socket = sockets[side]
              const socketInverse = socket?.getCTM()?.inverse()
              if (matrix === null || socket === undefined || socketInverse === undefined) {
                failures.push(`Seed ${index}: missing transform`)
                continue
              }
              const halfStroke = Number.parseFloat(getComputedStyle(brow).strokeWidth) / 2
              const length = brow.getTotalLength()
              let clearance = Infinity
              for (let sample = 0; sample <= 32; sample++) {
                const point = brow.getPointAtLength(length * sample / 32)
                // The round stroke extends in every direction. Check its perimeter as well as the fill.
                for (let edge = 0; edge < 8; edge++) {
                  const angle = edge * Math.PI / 4
                  const world = new DOMPoint(
                    point.x + halfStroke * Math.cos(angle),
                    point.y + halfStroke * Math.sin(angle)
                  ).matrixTransform(matrix)
                  const skin = world.matrixTransform(bodyInverse)
                  const face = world.matrixTransform(bobInverse)
                  const eye = world.matrixTransform(socketInverse)
                  if (!body.isPointInFill(skin)) failures.push(`Seed ${index}, side ${side}: outside silhouette`)
                  if (side === 0 ? face.x >= 50 : face.x <= 50) {
                    failures.push(`Seed ${index}, side ${side}: crossed centre`)
                  }
                  const x = (eye.x - socket.cx.baseVal.value) / socket.rx.baseVal.value
                  if (Math.abs(x) <= 1) {
                    const top = socket.cy.baseVal.value - socket.ry.baseVal.value * Math.sqrt(1 - x * x)
                    clearance = Math.min(clearance, top - eye.y)
                  }
                }
              }
              if (!(clearance > 0.01 && Number.isFinite(clearance))) {
                failures.push(`Seed ${index}, side ${side}: socket clearance ${clearance}`)
              }
            }
          }
          return [...new Set(failures)]
        }, [size, state] satisfies readonly [string, string])
        expect(failures).toEqual([])
      })
    }
  }

  test("ready brows share the wander clock and stay static under reduced motion", async ({ page }) => {
    await open(page, "no-preference")
    const svg = page.locator(".connect-agent svg.connect-creature").first()
    await svg.evaluate((node) => node.setAttribute("data-bucket", "ready"))
    const clocks = await svg.evaluate((node) => {
      const style = (selector: string) => getComputedStyle(node.querySelector(selector) ?? node)
      const brow = style(".connect-creature-brow")
      const gaze = style(".connect-creature-gaze")
      return {
        brow: [brow.animationDuration, brow.animationDelay],
        gaze: [gaze.animationDuration, gaze.animationDelay]
      }
    })
    expect(clocks.brow).toEqual(clocks.gaze)
    expect(clocks.brow[0]).not.toBe("0s")
    await page.emulateMedia({ reducedMotion: "reduce" })
    expect(await running(page)).toEqual([])
  })

  test("stale brows flatten without inheriting working tilt, and forced colours make them opaque", async ({ page }) => {
    await open(page, "reduce")
    const svg = page.locator(".connect-agent svg.connect-creature").first()
    await svg.evaluate((node) => node.setAttribute("data-stale", ""))
    const brow = svg.locator(".connect-creature-brow").first()
    await expect(brow).toHaveCSS("opacity", "0.45")
    await expect(brow).toHaveCSS("rotate", "0deg")
    await expect(brow).toHaveCSS("scale", "1 0.45")
    await expect(brow).toHaveCSS("translate", "0px 0.4px")
    await page.emulateMedia({ forcedColors: "active" })
    await expect(brow).toHaveCSS("opacity", "1")
    expect(await brow.evaluate((node) => getComputedStyle(node).fill)).toBe(
      await svg.locator(".connect-creature-pupil").first().evaluate((node) => getComputedStyle(node).fill)
    )
    await page.emulateMedia({ forcedColors: "none" })
    await page.evaluate(() => document.body.setAttribute("data-rly-forced-colors", "active"))
    await expect(brow).toHaveCSS("opacity", "1")
    expect(await brow.evaluate((node) => getComputedStyle(node).fill)).toBe(
      await svg.locator(".connect-creature-pupil").first().evaluate((node) => getComputedStyle(node).fill)
    )
  })

  // Same 64 seeds as the geometry checks, held still for design/live contact-sheet comparisons.
  for (const size of ["row", "cast", "stage"] satisfies ReadonlyArray<"row" | "cast" | "stage">) {
    for (const theme of ["light", "dark"] satisfies ReadonlyArray<"light" | "dark">) {
      for (const width of [390, 1280]) {
        for (const state of ["ready", "working", "needs-you", "finished", "stale"]) {
          test(`brow fidelity ${size} ${state} ${theme} ${width}`, async ({ page }, testInfo) => {
            await page.setViewportSize({ height: 844, width })
            await page.emulateMedia({ colorScheme: theme })
            await openBrowGrid(page)
            const presentation = agentStatePresentation(
              state === "stale" ? "working" : state === "finished" ? "done" : state === "needs-you" ? "waiting" : state
            )
            const pixels = { row: 36, cast: 60, stage: 240 }[size]
            await page.locator("[data-brow-grid]").evaluate(
              (grid, [shown, scheme, tone, drawnSize, edge]) => {
                document.documentElement.style.colorScheme = scheme
                document.body.setAttribute("data-rly-theme", scheme)
                document.body.replaceChildren(grid)
                document.body.style.overflow = "auto"
                grid.setAttribute(
                  "style",
                  `display:grid;grid-template-columns:repeat(auto-fit,${edge}px);gap:16px;padding:16px`
                )
                for (const svg of grid.querySelectorAll<SVGSVGElement>("svg")) {
                  svg.setAttribute("width", String(edge))
                  svg.setAttribute("height", String(edge))
                  svg.setAttribute("data-size", drawnSize)
                  svg.setAttribute("data-bucket", shown === "stale" ? "working" : shown)
                  svg.setAttribute("data-tone", tone)
                  if (shown === "stale") svg.setAttribute("data-stale", "")
                  for (const animation of svg.getAnimations({ subtree: true })) {
                    animation.pause()
                    const timing = animation.effect?.getTiming()
                    const duration = Number(timing?.duration ?? 0)
                    const delay = Number(timing?.delay ?? 0)
                    const name = "animationName" in animation ? String(animation.animationName) : ""
                    if (duration > 0) {
                      animation.currentTime = delay + Math.ceil(-delay / duration / 2) * 2 * duration
                        + duration * (name === "connect-creature-brow-lift" ? 0.2 : 0.001)
                    }
                  }
                }
              },
              [state, theme, presentation.tone, size, pixels] satisfies readonly [
                string,
                string,
                string,
                string,
                number
              ]
            )
            await expect(page.locator("[data-brow-grid] .connect-creature-brow")).toHaveCount(128)
            await page.screenshot({
              fullPage: true,
              path: testInfo.outputPath(`brows-${size}-${state}-${theme}-${width}.png`)
            })
          })
        }
      }
    }
  }
})
