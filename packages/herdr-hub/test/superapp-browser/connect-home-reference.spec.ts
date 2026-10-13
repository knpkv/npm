import { expect, test } from "@playwright/test"
import { strict as assert } from "node:assert"
import { type BodyKind, creaturePalette } from "../../../herdr-connect/src/character.js"
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
