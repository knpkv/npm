import { expect, test } from "@playwright/test"
import { strict as assert } from "node:assert"
import { agentCharacter, type BodyKind, creaturePalette } from "../../../herdr-connect/src/character.js"
import { captureFidelity } from "../../../herdr-connect/test/browser/creature-capture.js"
import { archiveFixture } from "./archive-fixture.js"
import { connectFixture } from "./connect-fixture.js"

const bodyKinds = new Map<string, BodyKind>([
  ["coord", "squircle"],
  ["release", "bean"],
  ["rev-usage", "squircle"],
  ["ds-rly", "bean"],
  ["pair-codex", "circle"],
  ["sec-cc", "circle"],
  ["pkgsrc", "circle"],
  ["lint-watch", "pear"],
  ["docs-sync", "pear"],
  ["fix-pins", "squircle"],
  ["doc-pass", "star"],
  ["probe-cedar", "star"],
  ["tok-audit", "squircle"],
  ["rev-tabs", "circle"],
  ["pair-css", "circle"],
  ["seed-data", "star"]
])
// Export 66 RelayCreatureStates.SEEDS, not fitted Fleet track bounds.
const designBounds = {
  circle: [24, 24],
  squircle: [23, 23],
  pear: [28, 24],
  star: [27.4, 26],
  bean: [27, 22]
} satisfies Record<BodyKind, readonly [number, number]>

const topology = {
  circle: [2, 0, 0],
  squircle: [0, 36, 0],
  pear: [0, 0, 4],
  star: [0, 0, 10],
  bean: [0, 32, 0]
} satisfies Record<BodyKind, readonly [number, number, number]>

for (const theme of ["light", "dark"]) {
  for (const frame of ["connect-home", "connect-home-ready", "connect-archived", "connect-partial", "connect-stage"]) {
    test(`Home reference ${frame} ${theme}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: theme === "dark" ? "dark" : "light", reducedMotion: "reduce" })
      const reading = connectFixture(
        1_791_721_200_000,
        frame === "connect-home-ready" ?
          "designready"
          : frame === "connect-partial"
          ? "designpartial"
          : "design"
      )
      const archived = archiveFixture()
      await page.route("**/v1/connect/agents", (route) => route.fulfill({ json: reading }))
      await page.route("**/v1/connect/archive*", (route) => route.fulfill({ json: archived }))
      await page.goto(
        frame === "connect-stage" ?
          "/?host=birch&agent=agent-rev-usage&open=stage#connect/overview"
          : frame === "connect-archived"
          ? "/?view=archived#connect/overview"
          : "/#connect/overview"
      )
      await page.locator("body").evaluate((body, value) => body.setAttribute("data-rly-theme", value), theme)
      const records = frame === "connect-archived"
        ? archived.agents.map((record) => ({ ...record, id: record.agentId })) :
        reading.agents
      for (const record of records) {
        const root = frame === "connect-archived"
          ? page.locator(".connect-home-archive-row").filter({ has: page.getByText(record.name, { exact: true }) })
          : page.locator(`.connect-home-agent[data-agent-key="${record.host}:${record.id}"]`)
        const body = root.locator(".connect-creature-body")
        await expect(body, `${frame}: ${record.host}:${record.name} is present`).toHaveCount(1)
        const segments = await body.evaluate((node) => {
          const path = node.getAttribute("d") ?? ""
          return [path.match(/A/g)?.length ?? 0, path.match(/C/g)?.length ?? 0, path.match(/Q/g)?.length ?? 0]
        })
        const expected = bodyKinds.get(record.name)
        assert(expected !== undefined, `No recorded Home body for ${record.name}`)
        expect(segments, `${record.name} uses its canonical stable ID payload`).toEqual(topology[expected])
        if (frame !== "connect-stage") {
          // Export 66 uses -6 -6 44 44 at 44/52px live and 36/40px closed slots.
          // A fixed slot must not inherit Fleet's tighter enclosing-ring body frame.
          const phone = (page.viewportSize()?.width ?? 0) < 600
          const slot = frame === "connect-archived" ? phone ? 36 : 40 : phone ? 44 : 52
          const geometry = await root.locator("[data-creature]").evaluate((node) => {
            const outline = node.querySelector<SVGGraphicsElement>(".connect-creature-body")
            const halo = node.querySelector<SVGEllipseElement>(".connect-creature-halo")
            const orbit = node.querySelector<SVGEllipseElement>(".connect-creature-orbit")
            const matrix = outline?.getScreenCTM()
            const haloMatrix = halo?.getScreenCTM()
            const orbitMatrix = orbit?.getScreenCTM()
            if (
              outline === null || halo === null || orbit === null || matrix == null || haloMatrix == null ||
              orbitMatrix == null
            ) return null
            const stroke = (part: SVGGraphicsElement, scale: number): number => {
              const style = getComputedStyle(part)
              return Number.parseFloat(style.strokeWidth) * (style.vectorEffect === "non-scaling-stroke" ? 1 : scale)
            }
            const bounds = node.getBoundingClientRect()
            const haloScale = Math.hypot(haloMatrix.a, haloMatrix.b)
            return {
              width: bounds.width,
              height: bounds.height,
              scale: Math.hypot(matrix.a, matrix.b),
              haloRadius: halo.rx.baseVal.value * haloScale,
              haloStroke: stroke(halo, haloScale),
              haloOpacity: Number(getComputedStyle(halo).opacity),
              needsYou: node.getAttribute("data-bucket") === "needs-you",
              muted: node.hasAttribute("data-stale") || node.hasAttribute("data-closed"),
              orbitDash: getComputedStyle(orbit).strokeDasharray.split(/[ ,]+/).map(Number.parseFloat),
              orbitStroke: stroke(orbit, Math.hypot(orbitMatrix.a, orbitMatrix.b))
            }
          })
          assert(geometry !== null, `${frame}: ${record.name} has a body, halo, orbit and screen matrices`)
          expect(geometry.width, `${record.name} keeps the export's ${String(slot)}px slot`).toBeCloseTo(slot, 2)
          expect(geometry.height).toBeCloseTo(slot, 2)
          const designScale = slot / 44
          expect(
            geometry.scale * agentCharacter(record.host, record.id).unit,
            `${record.name} painted body uses ${String(slot)}/44 design scale, not Fleet fit`
          ).toBeCloseTo(designScale, 3)
          if (frame !== "connect-archived") {
            const [designWidth, designHeight] = designBounds[expected]
            // RelayCreatureStates.draw: r=max(w,h)/2+2.25; RelayAgent ring width=1.
            expect(geometry.haloRadius).toBeCloseTo((Math.max(designWidth, designHeight) / 2 + 2.25) * designScale, 2)
            expect(geometry.haloStroke, `${record.name} thin Home solid state ring`).toBeCloseTo(designScale, 3)
            expect(geometry.orbitStroke, `${record.name} thin Home working arc`).toBeCloseTo(designScale, 3)
            expect(geometry.haloOpacity).toBe(geometry.needsYou && !geometry.muted ? 1 : 0)
            expect(geometry.orbitDash).toEqual([22, 78])
          }
        }

        await expect(body).toHaveAttribute(
          "fill",
          creaturePalette(record.host, record.name, record.hue, frame === "connect-archived" ? 0.1 : 1).p46
        )
      }
      if (frame === "connect-stage") {
        const dialog = page.getByRole("dialog", { name: "rev-usage", exact: true })
        await expect(dialog).toBeVisible()
        await expect(dialog.locator(".connect-creature-body").first()).toHaveAttribute("fill", "#11703a")
      }
      await page.evaluate(() => document.fonts.ready)
      const width = page.viewportSize()?.width ?? 0
      await captureFidelity(page, info.outputPath(`${frame}-${String(width)}-${theme}.png`))
    })
  }
}
