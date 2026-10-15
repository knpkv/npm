import { expect, type Locator, type Page, test } from "@playwright/test"
import type { CreatureMood } from "../../src/creature-state.js"
import { paintBox } from "./creature-capture.js"

/** Mount the production drawing without directory polling or a stage's entry animation. */
const open = async (page: Page, query: string, motion: "reduce" | "no-preference" = "reduce") => {
  await page.emulateMedia({ reducedMotion: motion })
  await page.goto(`/?drawing=single&${query}`)
  const creature = page.locator("[data-drawing-case] .connect-creature")
  await expect(creature).toHaveCount(1)
  return creature
}

/** Sample a named pose independently of its seeded head start. */
const pose = (creature: Locator, share: number) =>
  creature.evaluate((svg, at) => {
    for (const animation of svg.getAnimations({ subtree: true })) {
      animation.pause()
      const timing = animation.effect?.getTiming()
      const duration = Number(timing?.duration ?? 0)
      animation.currentTime = Number(timing?.delay ?? 0) + duration * at
    }
  }, share)

/** The body scale relative to its own SVG, including every CSS and SVG ancestor transform. */
const bodyScale = (creature: Locator) =>
  creature.evaluate((node) => {
    const svg = node.querySelector<SVGPathElement>(".connect-creature-body")?.ownerSVGElement
    const body = node.querySelector<SVGPathElement>(".connect-creature-body")
    const rootMatrix = svg?.getScreenCTM()
    const bodyMatrix = body?.getScreenCTM()
    if (rootMatrix === null || rootMatrix === undefined || bodyMatrix === null || bodyMatrix === undefined) {
      return null
    }
    const matrix = rootMatrix.inverse().multiply(bodyMatrix)
    return { x: Math.hypot(matrix.a, matrix.b), y: Math.hypot(matrix.c, matrix.d) }
  })

/** Allow matrix arithmetic rounding, but never hide a missing body or a visible deformation. */
const expectScale = (scale: Awaited<ReturnType<typeof bodyScale>>, value: number) => {
  expect(scale).not.toBeNull()
  expect(scale?.x).toBeCloseTo(value, 3)
  expect(scale?.y).toBeCloseTo(value, 3)
}

for (const theme of ["light", "dark"] satisfies ReadonlyArray<"light" | "dark">) {
  test.describe(`Creature drawing, ${theme}`, () => {
    test.use({ colorScheme: theme })

    for (const size of ["row", "cast", "stage"]) {
      test(`rev6 seeded ${size} bodies cover circle, squircle, pear, star and bean`, async ({ page }) => {
        await page.goto(`/?drawing=grid&size=${size}`)
        const creatures = page.locator("[data-drawing-case] .connect-creature")
        await expect(creatures).toHaveCount(64)
        const silhouettes = await creatures.evaluateAll((nodes) =>
          nodes.map((svg) => {
            const body = svg.querySelector<SVGPathElement>(".connect-creature-body")
            if (body === null) return "missing body"
            const box = body.getBBox()
            const aspect = box.width / box.height
            const inside = (x: number, y: number) =>
              body.isPointInFill(new DOMPoint(box.x + box.width * x, box.y + box.height * y))
            const length = body.getTotalLength()
            const radii = Array.from({ length: 180 }, (_, index) => {
              const point = body.getPointAtLength(length * index / 180)
              return Math.hypot((point.x - box.x) / box.width - 0.5, (point.y - box.y) / box.height - 0.5)
            })
            if (Math.abs(aspect - 1) < 0.003 && Math.max(...radii) - Math.min(...radii) < 0.003) {
              return "circle"
            }
            // An ellipse leaves these diagonal corner points empty; M2's soft square fills all four.
            const corners = [[0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]] satisfies ReadonlyArray<
              readonly [number, number]
            >
            if (Math.abs(aspect - 1) < 0.01 && corners.every(([x, y]) => inside(x, y))) {
              return "squircle"
            }
            const span = (y: number) =>
              Array.from({ length: 100 }, (_, index) => inside((index + 0.5) / 100, y)).filter(Boolean).length
            // The pear is a rounded trapezoid with a visibly wider base, not a stretched circle.
            if (
              aspect > 1.05 && aspect < 1.3 && span(0.75) > span(0.25) * 1.15
              && !inside(0.1, 0.1) && !inside(0.9, 0.1) && inside(0.15, 0.85) && inside(0.85, 0.85)
            ) {
              return "pear"
            }
            const path = body.getAttribute("d") ?? ""
            // Five rounded tips retain a concave lower notch; a bean has a cleft above its full centre.
            if ((path.match(/Q/g)?.length ?? 0) === 10 && inside(0.5, 0.15) && !inside(0.5, 0.95)) {
              return "star"
            }
            // The exported bean paints at aspect 1.36124; its cleft ends at 6.83% of painted height.
            if (
              (path.match(/C/g)?.length ?? 0) === 32 && aspect > 1.35 && aspect < 1.37 && !inside(0.5, 0.04)
              && inside(0.5, 0.3) && inside(0.5, 0.8)
            ) {
              return "bean"
            }
            return `unrecognised silhouette, aspect ${String(aspect)}`
          })
        )
        expect(silhouettes.filter((silhouette) => !["circle", "squircle", "pear", "star", "bean"].includes(silhouette)))
          .toEqual([])
        expect(new Set(silhouettes)).toEqual(new Set(["circle", "squircle", "pear", "star", "bean"]))
      })
    }

    for (const size of ["row", "stage"]) {
      test(`rev6 waiting ${size} has raised brows and wider eyes than working`, async ({ page }) => {
        const working = await open(page, `id=drawing-0&size=${size}&state=working`)
        const face = (creature: Locator) =>
          creature.evaluate((svg) => {
            const unit = Number.parseFloat(getComputedStyle(svg).getPropertyValue("--connect-creature-unit"))
            const eye = svg.querySelector<SVGPathElement>(".connect-creature-white")?.getBBox()
            const brow = svg.querySelector<SVGPathElement>(".connect-creature-brow")?.getBBox()
            return {
              eyeHeight: (eye?.height ?? 0) / unit,
              browGap: ((eye?.y ?? 0) - (brow?.y ?? 0) - (brow?.height ?? 0)) / unit
            }
          })
        const focused = await face(working)
        const waiting = await face(await open(page, `id=drawing-0&size=${size}&state=waiting`))
        // 02 Connect rev6 draw.P uses eyeS=1.08; sampled paths retain only rounding error.
        expect(waiting.eyeHeight / focused.eyeHeight).toBeCloseTo(1.08, 3)
        expect(waiting.browGap).toBeGreaterThan(focused.browGap)
      })

      test(`rev6 done ${size} keeps visible happy arcs at rest`, async ({ page }) => {
        const creature = await open(page, `size=${size}&state=done`)
        const arcs = creature.locator(".connect-creature-eye-mark[data-eyes=\"arc\"]")
        await expect(arcs).toHaveCount(2)
        for (const arc of await arcs.all()) await expect(arc).toBeVisible()
        await expect(creature.locator(".connect-creature-mouth")).toHaveCount(0)
      })

      test(`rev6 stale ${size} has half lids rather than closed eyes`, async ({ page }) => {
        const creature = await open(page, `size=${size}&state=working&stale`, "no-preference")
        const lids = await creature.evaluate((svg) => {
          const style = getComputedStyle(svg)
          const span = Number.parseFloat(style.getPropertyValue("--connect-creature-eye-span"))
          const socket = Number.parseFloat(style.getPropertyValue("--connect-creature-eye-socket"))
          return [...svg.querySelectorAll("clipPath .connect-creature-lid:not([data-low])")].map((lid) =>
            (Number.parseFloat(getComputedStyle(lid).translate.split(" ")[1] ?? "0") - socket) / span
          )
        })
        expect(lids).toHaveLength(2)
        for (const fraction of lids) expect(fraction).toBeCloseTo(0.5, 2)
        expect(await creature.evaluate((svg) => svg.getAnimations({ subtree: true }).length)).toBe(0)
        await expect(creature.locator(".connect-creature-mouth")).toHaveCount(0)
      })
    }

    test("rev6 agent faces have no leftover blink, brow twitch or reading motion", async ({ page }) => {
      for (const state of ["working", "waiting", "blocked", "done", "ready"]) {
        const creature = await open(page, `state=${state}`, "no-preference")
        const names = await creature.locator(
          ".connect-creature-lid, .connect-creature-lash, .connect-creature-brow, .connect-creature-gaze"
        ).evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).animationName))
        expect(names.length).toBeGreaterThanOrEqual(9)
        expect(names.every((name) => name === "none"), `${state}: ${names.join(", ")}`).toBe(true)
      }
    })

    test("cast faces retain two eyes and brows at 16 and 24 pixels", async ({ page }) => {
      await page.goto("/?drawing=grid&size=cast")
      const creatures = page.locator("[data-drawing-case] .connect-creature")
      await expect(creatures).toHaveCount(64)
      for (const pixels of [16, 24]) {
        const faces = await creatures.evaluateAll((nodes, edge) =>
          nodes.map((svg) => {
            svg.setAttribute(
              "style",
              `${svg.getAttribute("style") ?? ""};inline-size:${String(edge)}px;block-size:${String(edge)}px`
            )
            const body = svg.querySelector(".connect-creature-body")?.getBoundingClientRect()
            const widths = (selector: string) =>
              [...svg.querySelectorAll(selector)].map((node) => node.getBoundingClientRect().width)
            return {
              bodyWidth: body?.width ?? 0,
              eyes: widths(".connect-creature-white"),
              pupils: widths(".connect-creature-pupil"),
              brows: widths(".connect-creature-brow")
            }
          }), pixels)
        for (const face of faces) {
          expect(face.bodyWidth).toBeGreaterThan(pixels * 0.55)
          expect(face.eyes).toHaveLength(2)
          expect(face.pupils).toHaveLength(2)
          expect(face.brows).toHaveLength(2)
          for (const width of face.eyes) expect(width).toBeGreaterThan(1.25)
          for (const width of face.pupils) expect(width).toBeGreaterThan(0.55)
          for (const width of face.brows) expect(width).toBeGreaterThan(1.25)
        }
      }
    })

    test("flat colour steps replace the glossy gradient body and crescent brows", async ({ page }) => {
      const creature = await open(page, "mood=focused")
      const body = creature.locator(".connect-creature-body")
      expect(await body.evaluate((node) => getComputedStyle(node).fill)).not.toContain("url(")
      const brows = await creature.locator(".connect-creature-brow").evaluateAll((nodes) =>
        nodes.map((node) => ({
          fill: getComputedStyle(node).fill,
          stroke: getComputedStyle(node).stroke,
          width: Number.parseFloat(getComputedStyle(node).strokeWidth)
        }))
      )
      expect(brows).toHaveLength(2)
      for (const brow of brows) {
        expect(brow.fill).toBe("none")
        expect(brow.stroke).not.toBe("none")
        expect(brow.width).toBeGreaterThan(0)
      }
      await expect(creature.locator(".connect-creature-blush")).toHaveCount(2)
    })

    test("non-talking agents keep their true body through every mood and arrival", async ({ page }) => {
      const moods = [
        "happy",
        "focused",
        "worried",
        "sleepy",
        "excited",
        "waiting",
        "speaking",
        "thinking",
        "stuck",
        "done"
      ]
      for (const mood of moods) {
        const creature = await open(page, `mood=${mood}`, "no-preference")
        await creature.evaluate((node) => node.setAttribute("data-arrived", ""))
        for (const share of [0.08, 0.25, 0.6, 0.95]) {
          await pose(creature, share)
          const scale = await bodyScale(creature)
          expect(scale).not.toBeNull()
          expect(scale?.x, `${mood}, ${String(share)}`).toBeCloseTo(1, 3)
          expect(scale?.y, `${mood}, ${String(share)}`).toBeCloseTo(1, 3)
        }
        await expect(creature.locator(".connect-creature-mouth")).toHaveCount(0)
      }
    })

    test("only a talking stage draws a mouth; row talking stays blush only", async ({ page }) => {
      const stage = await open(page, "mood=speaking&talking")
      await expect(stage.locator(".connect-creature-mouth")).toHaveCount(1)
      const row = await open(page, "mood=speaking&size=row&talking")
      await expect(row.locator(".connect-creature-mouth")).toHaveCount(0)
      await expect(row.locator(".connect-creature-blush")).toHaveCount(2)
    })

    // 02 Connect rev6 draw.P: idle/ready use open rest eyes; sleepy remains an explicit talk pose.
    test("rev6 ordinary idle and ready keep open rest eyes without sleep marks", async ({ page }) => {
      for (const state of ["idle", "ready"]) {
        const creature = await open(page, `size=row&state=${state}`, "no-preference")
        await expect(creature).not.toHaveAttribute("data-lidded")
        await expect(creature).not.toHaveAttribute("data-loop")
        await expect(creature.locator(".connect-creature-z")).toHaveCount(0)
        expect(await creature.evaluate((node) => getComputedStyle(node).getPropertyValue("--connect-creature-lower")))
          .toBe("0")
      }
    })

    // 02 Connect rev6 draw uses grayscale(1), opacity .7, half lids and no state ring for stale readings.
    test("rev6 stale creatures lose all hue and rings while keeping half lids", async ({ page }) => {
      for (const size of ["row", "cast", "stage"]) {
        // Emulated forced colours survive navigation; restore the ordinary paint before each slot.
        await page.emulateMedia({ forcedColors: "none" })
        const creature = await open(page, `size=${size}&state=waiting&stale`, "no-preference")
        await expect(creature).toHaveCSS("filter", "grayscale(1)")
        await expect(creature).toHaveCSS("opacity", "0.7")
        await expect(creature.locator(".connect-creature-halo")).toHaveCSS("opacity", "0")
        await expect(creature.locator(".connect-creature-orbit")).toHaveCSS("opacity", "0")
        await page.emulateMedia({ forcedColors: "active" })
        await expect(creature).toHaveCSS("filter", "none")
      }
    })

    // 02 Connect rev6 draw.TONE and CS.draw ring: severity selects the stroke, never identity hue.
    test("rev6 row cast and stage rings are circular and carry their state tone", async ({ page }) => {
      for (const size of ["row", "cast", "stage"]) {
        for (const state of ["waiting", "blocked", "working"]) {
          const creature = await open(page, `size=${size}&id=agent-ds-rly&family=rose&state=${state}`)
          const stroke = state === "working" ? ".connect-creature-orbit" : ".connect-creature-halo"
          const colour = await creature.evaluate((node, state) => {
            const token = state === "working" ? "deploying" : state === "waiting" ? "held" : "blocked"
            const probe = document.createElement("span")
            probe.style.color = `var(--rly-color-${token}-ink)`
            node.parentElement?.append(probe)
            const expected = getComputedStyle(probe).color
            const halo = node.querySelector<SVGEllipseElement>(".connect-creature-halo")
            probe.remove()
            return { expected, rx: halo?.rx.baseVal.value, ry: halo?.ry.baseVal.value }
          }, state)
          await expect(creature.locator(stroke)).toHaveCSS("stroke", colour.expected)
          expect(colour.rx).toBe(colour.ry)
        }
      }
    })

    test("rev6 blocked and error agents default to the worried face without talk overlays", async ({ page }) => {
      for (const state of ["blocked", "error"]) {
        const creature = await open(page, `state=${state}`)
        await expect(creature).toHaveAttribute("data-mood", "worried")
        await expect(creature.locator(".connect-creature-sweat")).toHaveCount(0)
        await expect(creature.locator(".connect-creature-question")).toHaveCount(0)
        await expect(creature.locator(".connect-creature-mouth")).toHaveCount(0)
        expectScale(await bodyScale(creature), 1)
      }
    })

    // The list reference uses a larger drop than the stage, so it remains visible at its native 32px slot.
    test("stuck sweat stays visible at 32 pixels on every list body", async ({ page }) => {
      for (const id of ["drawing-0", "drawing-1", "drawing-2"]) {
        const creature = await open(page, `id=${id}&mood=stuck&size=row`)
        await creature.evaluate((node) => {
          node.style.inlineSize = "32px"
          node.style.blockSize = "32px"
        })
        const drop = creature.locator(".connect-creature-sweat > path")
        await expect(drop).toHaveAttribute("fill", "white")
        const playwrightBox = await drop.boundingBox()
        const geometry = await creature.evaluate((node) => {
          const path = node.querySelector<SVGPathElement>(".connect-creature-sweat > path")
          const matrix = path?.getScreenCTM()
          if (path === null || matrix === null || matrix === undefined) return null
          const local = path.getBBox()
          const points = [
            new DOMPoint(local.x, local.y),
            new DOMPoint(local.x + local.width, local.y),
            new DOMPoint(local.x, local.y + local.height),
            new DOMPoint(local.x + local.width, local.y + local.height)
          ].map((point) => point.matrixTransform(matrix))
          const root = node.getBoundingClientRect()
          const client = path.getBoundingClientRect()
          return {
            size: node.getAttribute("data-size"),
            root: { width: root.width, height: root.height },
            local: { width: local.width, height: local.height },
            client: { width: client.width, height: client.height },
            painted: {
              width: Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x)),
              height: Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y))
            }
          }
        })
        const measured = JSON.stringify({ id, theme, geometry, playwrightBox })
        expect(geometry, measured).not.toBeNull()
        expect(geometry?.size, measured).toBe("row")
        expect(geometry?.root.width, measured).toBeCloseTo(32, 2)
        expect(geometry?.root.height, measured).toBeCloseTo(32, 2)
        // 2.8 x 4.48 reference units in the 40-unit frame: 2.24 x 3.58px at 32px.
        expect(geometry?.painted.width, measured).toBeGreaterThanOrEqual(2.2)
        expect(geometry?.painted.height, measured).toBeGreaterThanOrEqual(3.5)
        expect(
          await creature.locator(".connect-creature-sweat").evaluate((node) => Number(getComputedStyle(node).opacity))
        ).toBeGreaterThanOrEqual(0.9)
      }
    })

    test("agents have no accessory by default; the four neutral role accessories paint without a toque", async ({ page }) => {
      const plain = await open(page, "mood=happy")
      await expect(plain.locator(".connect-creature-accessory")).toHaveCount(0)
      for (const accessory of ["headphones", "hard-hat", "scarf", "glasses"]) {
        const creature = await open(page, `mood=happy&accessory=${accessory}`)
        const adornment = creature.locator(".connect-creature-accessory")
        await expect(adornment).toHaveCount(1)
        await expect(adornment).toHaveAttribute("data-accessory", accessory)
        expect(await adornment.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(0)
      }
      const forbidden = await open(page, "accessory=chef-hat")
      await expect(forbidden.locator(".connect-creature-accessory")).toHaveCount(0)
    })

    test("accessories remain legible at 24 pixels on every body and keep the eyes clear", async ({ page }) => {
      for (const id of ["drawing-1", "drawing-2", "drawing-0"]) {
        for (const accessory of ["headphones", "hard-hat", "scarf", "glasses"]) {
          const creature = await open(page, `id=${id}&mood=happy&size=row&accessory=${accessory}`)
          await creature.evaluate((node) =>
            node.setAttribute("style", `${node.getAttribute("style") ?? ""};inline-size:24px;block-size:24px`)
          )
          const faces = await creature.evaluate((node) => {
            const boxes = (selector: string) =>
              [...node.querySelectorAll(selector)].map((element) => {
                const box = element.getBoundingClientRect()
                return {
                  x: box.x,
                  y: box.y,
                  right: box.right,
                  bottom: box.bottom,
                  width: box.width,
                  height: box.height
                }
              })
            return {
              eyes: boxes(".connect-creature-white"),
              brows: boxes(".connect-creature-brow"),
              accessory: boxes(".connect-creature-accessory"),
              lenses: boxes("[data-part=\"lens\"]"),
              cups: boxes("[data-part=\"cup\"]"),
              brim: boxes("[data-part=\"brim\"]"),
              tail: boxes("[data-part=\"tail\"]")
            }
          })
          expect(faces.eyes).toHaveLength(2)
          expect(faces.accessory).toHaveLength(1)
          expect(faces.accessory[0]?.height).toBeGreaterThan(1)
          if (accessory === "glasses") {
            expect(faces.lenses).toHaveLength(2)
            for (const [index, eye] of faces.eyes.entries()) {
              const lens = faces.lenses[index]
              expect(lens?.x).toBeLessThan(eye.x)
              expect(lens?.right).toBeGreaterThan(eye.right)
              expect(lens?.y).toBeLessThan(eye.y)
              expect(lens?.bottom).toBeGreaterThan(eye.bottom)
            }
          }
          if (accessory === "headphones") {
            expect(faces.cups).toHaveLength(2)
            expect(faces.cups[0]?.right).toBeLessThan(faces.eyes[0]?.x ?? 0)
            expect(faces.cups[1]?.x).toBeGreaterThan(faces.eyes[1]?.right ?? 0)
          }
          if (accessory === "hard-hat") {
            expect(faces.brim[0]?.bottom).toBeLessThan(Math.min(...faces.brows.map(({ y }) => y)))
          }
          if (accessory === "scarf") {
            expect(faces.tail[0]?.y).toBeGreaterThan(Math.max(...faces.eyes.map(({ bottom }) => bottom)))
          }
        }
      }
    })

    // CS.draw's lid>=.95 frame: endpoints at eye centre, quadratic control 1.3 units below.
    test("rev6 closed lashes retain the full curved shut-eye stroke", async ({ page }) => {
      for (const size of ["row", "stage"]) {
        const creature = await open(page, `size=${size}&state=working&closed`)
        const lashes = await creature.evaluate((root) => {
          const unit = Number.parseFloat(getComputedStyle(root).getPropertyValue("--connect-creature-unit"))
          return [...root.querySelectorAll<SVGPathElement>(".connect-creature-lash")].map((node) => {
            const box = node.getBBox()
            const socket = node.closest("[clip-path]")
            return {
              width: box.width / unit,
              height: box.height / unit,
              clippedBySocket: socket?.getAttribute("clip-path")?.includes("socket") ?? false
            }
          })
        })
        expect(lashes).toHaveLength(2)
        for (const lash of lashes) {
          expect(lash.width).toBeCloseTo(4.25, 2)
          expect(lash.height).toBeCloseTo(0.65, 2)
          expect(lash.clippedBySocket).toBe(false)
        }
      }
    })

    test("closed faces stay shut and still with no ring in ordinary and forced colours", async ({ page }) => {
      const creature = await open(page, "state=blocked&closed&talking", "no-preference")
      for (const forcedColors of ["none", "active"] satisfies ReadonlyArray<"none" | "active">) {
        await page.emulateMedia({ forcedColors })
        expect(await creature.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0)
        for (const selector of [".connect-creature-breath", ".connect-creature-lid"]) {
          const names = await creature.locator(selector).evaluateAll((nodes) =>
            nodes.map((node) => getComputedStyle(node).animationName)
          )
          expect(names.every((name) => name === "none")).toBe(true)
        }
        await expect(creature.locator(".connect-creature-halo")).toHaveCSS("opacity", "0")
        await expect(creature.locator(".connect-creature-orbit")).toHaveCSS("opacity", "0")
        await expect(creature.locator(".connect-creature-mouth")).toHaveCount(0)
        const brows = await creature.locator(".connect-creature-brow").evaluateAll((nodes) =>
          nodes.map((node) => {
            const style = getComputedStyle(node)
            return { fill: style.fill, stroke: style.stroke, opacity: Number(style.opacity) }
          })
        )
        expect(brows).toHaveLength(2)
        for (const brow of brows) {
          expect(brow.fill).toBe("none")
          expect(brow.stroke).not.toBe("none")
          expect(brow.opacity).toBe(forcedColors === "active" ? 1 : 0.45)
        }
        expectScale(await bodyScale(creature), 1)
        if (forcedColors === "active") {
          expect(await creature.locator(".connect-creature-body").evaluate((node) => getComputedStyle(node).stroke)).not
            .toBe("none")
        }
      }
    })

    test("done plays on the transition once, then rests happy without replaying on mount", async ({ page }) => {
      const finished = await open(page, "state=done", "no-preference")
      await expect(finished).toHaveAttribute("data-mood", "happy")
      const creature = await open(page, "state=working", "no-preference")
      await page.getByRole("button", { name: "Finish agent" }).click()
      await expect(creature).toHaveAttribute("data-mood", "done")
      await expect(creature).toHaveAttribute("data-mood", "happy", { timeout: 2500 })
      await expect(creature.locator(".connect-creature-mouth")).toHaveCount(0)
    })

    for (const preference of ["system", "in-app", "legacy"] satisfies ReadonlyArray<"system" | "in-app" | "legacy">) {
      for (
        const when of ["before finish", "during celebration"] satisfies ReadonlyArray<
          "before finish" | "during celebration"
        >
      ) {
        test(`done settles immediately with ${preference} reduced motion ${when}`, async ({ page }) => {
          const creature = await open(page, "state=working&talking", "no-preference")
          const reduce = async () => {
            if (preference === "system") await page.emulateMedia({ reducedMotion: "reduce" })
            else {await page.locator("[data-drawing-fixture]").evaluate(
                (owner, name) => owner.setAttribute(name, "reduce"),
                preference === "in-app" ? "data-rly-reduced-motion" : "data-reduced-motion"
              )}
          }
          if (when === "before finish") await reduce()
          await page.getByRole("button", { name: "Finish agent" }).click()
          if (when === "during celebration") {
            await expect(creature).toHaveAttribute("data-mood", "done")
            await reduce()
          }
          await expect(creature).toHaveAttribute("data-mood", "happy", { timeout: 300 })
          await expect(creature.locator(".connect-creature-celebration")).toHaveCount(0)
          expect(await creature.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0)
        })
      }
    }

    test("talking happy loops use the state timing and keep the fleet out of phase", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "no-preference" })
      await page.goto("/?drawing=grid&mood=happy&talking")
      const creatures = page.locator("[data-drawing-case] .connect-creature")
      await expect(creatures).toHaveCount(64)
      const timings = await creatures.evaluateAll((nodes) =>
        nodes.map((node) =>
          node.getAnimations({ subtree: true }).map((animation) => animation.effect?.getTiming()).filter((timing) =>
            timing?.duration === 1600 && timing.iterations === Infinity
          ).map((timing) => timing?.delay)
        )
      )
      expect(timings.every((values) => values.length > 0)).toBe(true)
      const delays = timings.flat()
      expect(delays.every((delay) => delay !== undefined && delay < 0)).toBe(true)
      expect(new Set(delays).size).toBeGreaterThan(8)
    })

    for (
      const [reaction, duration] of [["listening", 720], ["poke", 620]] satisfies ReadonlyArray<
        readonly [string, number]
      >
    ) {
      test(`${reaction} is a replayable one-shot and returns to the true shape`, async ({ page }) => {
        const creature = await open(page, `reaction=${reaction}&talking`, "no-preference")
        const read = () =>
          creature.evaluate((node, expectedDuration) =>
            node.getAnimations({ subtree: true }).map((animation) => ({
              time: Number(animation.currentTime),
              duration: animation.effect?.getTiming().duration,
              iterations: animation.effect?.getTiming().iterations
            })).filter((timing) => timing.duration === expectedDuration), duration)
        expect((await read()).some((timing) => timing.iterations === 1)).toBe(true)
        await pose(creature, 0.2)
        const moving = await bodyScale(creature)
        expect(moving).not.toBeNull()
        expect(Math.max(Math.abs((moving?.x ?? 1) - 1), Math.abs((moving?.y ?? 1) - 1))).toBeGreaterThan(0.01)
        await pose(creature, 1)
        expectScale(await bodyScale(creature), 1)
        await page.getByRole("button", { name: "Replay reaction" }).click()
        expect((await read()).some((timing) => timing.time >= 0 && timing.time < duration && timing.iterations === 1))
          .toBe(true)
        if (reaction === "poke") {
          // Filled sibling animations must restart too, not just the keyed body subtree.
          const overlays = await creature.evaluate((node) =>
            node.getAnimations({ subtree: true })
              .flatMap((animation) => {
                if (!("animationName" in animation)) return []
                const name = animation.animationName
                // Membership in the two named CSS effects proves the string without constructor identity.
                if (name !== "connect-creature-tap-fade" && name !== "connect-creature-ticks-show") return []
                return [{ name, time: Number(animation.currentTime) }]
              })
          )
          expect(overlays.map(({ name }) => name).sort()).toEqual([
            "connect-creature-tap-fade",
            "connect-creature-ticks-show"
          ])
          for (const overlay of overlays) {
            expect(overlay.time, `${overlay.name} restarts with reactionKey`).toBeLessThan(duration)
          }
          await pose(creature, 0)
          await expect(creature.locator(".connect-creature-tap")).toHaveCSS("opacity", "1")
          await expect(creature.locator(".connect-creature-ticks")).toHaveCSS("opacity", "0")
          await pose(creature, 1)
          await expect(creature.locator(".connect-creature-tap")).toHaveCSS("opacity", "0")
          await expect(creature.locator(".connect-creature-ticks")).toHaveCSS("opacity", "1")
        }
      })
    }

    test("talking stuck holds a uniform 96 percent; resolving restores the true shape", async ({ page }) => {
      const creature = await open(page, "state=blocked&talking", "no-preference")
      await pose(creature, 1)
      const stuck = await bodyScale(creature)
      expect(stuck?.x).toBeCloseTo(0.96, 3)
      expect(stuck?.y).toBeCloseTo(0.96, 3)
      const resolved = await open(page, "state=working&talking")
      expectScale(await bodyScale(resolved), 1)
    })

    test("system and in-app reduced motion keep every new state and reaction still", async ({ page }) => {
      for (const mood of ["focused", "sleepy", "excited", "listening", "poke", "stuck", "done"]) {
        const creature = await open(page, `mood=${mood}&talking&reaction=poke`)
        expect(await creature.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0)
        await page.emulateMedia({ reducedMotion: "no-preference" })
        await page.locator("body").evaluate((node) => node.setAttribute("data-rly-reduced-motion", "reduce"))
        expect(await creature.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0)
      }
    })
    for (const size of ["stage", "row"] satisfies ReadonlyArray<"stage" | "row">) {
      for (
        const mood of [
          "happy",
          "focused",
          "worried",
          "sleepy",
          "excited",
          "waiting",
          "speaking",
          "thinking",
          "listening",
          "poke",
          "stuck",
          "done"
        ] satisfies ReadonlyArray<CreatureMood>
      ) {
        test(`reference creature ${mood} ${size}`, async ({ page }, testInfo) => {
          if (mood === "done") {
            // State sheet 10m starts with closed happy arcs at 0ms. Freeze before mount; reduction skips to settled happy.
            await page.route("**/assets/connect.css", async (route) => {
              const response = await route.fetch()
              await route.fulfill({
                response,
                body: `${await response
                  .text()}\n[data-drawing-case] .connect-creature[data-mood="done"] * { animation-play-state: paused; }`
              })
            })
          }
          const creature = await open(
            page,
            `id=drawing-1&state=ready&mood=${mood}&size=${size}&family=iris&talking`,
            mood === "done" ? "no-preference" : "reduce"
          )
          if (mood === "done") {
            await pose(creature, 0)
            const animations = await creature.evaluate((node) =>
              node.getAnimations({ subtree: true }).map((animation) => animation.playState)
            )
            expect(animations.length).toBeGreaterThan(0)
            expect(animations.every((state) => state === "paused")).toBe(true)
          }
          // The shared fixture starts dark; use the requested theme and the directory row's own surface.
          await page.locator("html, body").evaluateAll((nodes, scheme) => {
            for (const node of nodes) node.setAttribute("data-rly-theme", scheme)
          }, theme)
          await page.addStyleTag({ content: "body.connect-body { background: var(--rly-color-surface-1); }" })
          expect(await page.locator("body").evaluate((node) => getComputedStyle(node).colorScheme)).toBe(theme)
          const pixels = size === "stage" ? 128 : 32
          await creature.evaluate(
            (node, edge) =>
              node.setAttribute(
                "style",
                `${node.getAttribute("style") ?? ""};inline-size:${String(edge)}px;block-size:${String(edge)}px`
              ),
            pixels
          )
          await expect(creature).toHaveAttribute("data-mood", mood)
          const clip = await paintBox(creature)
          expect(clip).not.toBeNull()
          if (clip !== null) {
            await page.screenshot({
              clip,
              path: testInfo.outputPath(`creature--${mood}--${size === "row" ? "list" : "stage"}-${theme}.png`)
            })
          }
          const times = {
            happy: [0, 120, 260, 460],
            focused: [0, 200, 900, 1500],
            worried: [0, 180, 520, 800],
            sleepy: [0, 1200, 2400, 3200],
            excited: [0, 140, 320, 460],
            waiting: [0, 1600, 2400, 3400],
            speaking: [0, 90, 180, 300],
            thinking: [0, 300, 600, 900],
            listening: [0, 160, 320, 520],
            poke: [0, 60, 220, 400],
            stuck: [0, 300, 700, 1000],
            // relay-creature-states.js, 10m: arcs at0, chest-out at200, settling at480, happy rest at900.
            // Sample899 just before completion removes the one-shot; reduced settlement has separate guards.
            done: [0, 200, 480, 899]
          } satisfies Record<CreatureMood, ReadonlyArray<number>>
          await page.emulateMedia({ reducedMotion: "no-preference" })
          await creature.evaluate((node) => {
            for (const animation of node.getAnimations({ subtree: true })) animation.pause()
          })
          for (const time of times[mood]) {
            await creature.evaluate((node, at) => {
              for (const animation of node.getAnimations({ subtree: true })) {
                animation.pause()
                animation.currentTime = Number(animation.effect?.getTiming().delay ?? 0) + at
              }
            }, time)
            const frame = await paintBox(creature)
            expect(frame).not.toBeNull()
            if (frame !== null) {
              await page.screenshot({
                clip: frame,
                path: testInfo.outputPath(
                  `creature--${mood}--${size === "row" ? "list" : "stage"}-${theme}-${String(time)}ms.png`
                )
              })
            }
          }
        })
      }
    }
  })
}
