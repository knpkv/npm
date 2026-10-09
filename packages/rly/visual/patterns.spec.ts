import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures.ts"

const story = (id: string, forcedColors = "auto"): string =>
  `/iframe.html?id=${id}&viewMode=story&globals=theme:dark;forcedColors:${forcedColors};reducedMotion:reduce;locale:en;density:comfortable`

const expectNoHorizontalOverflow = async (page: Page): Promise<void> => {
  const dimensions = await page.locator("html").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth
  }))
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client)
}

test("keeps all service and freshness identities explicit in forced colors", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_000, width: 320 })
  await page.goto(story("patterns-evidencestamp--compact-forced-colors", "active"))

  for (const provider of ["CodeCommit", "CodePipeline", "Jira", "Confluence", "Clockify"]) {
    await expect(page.getByRole("img", { name: provider })).toBeVisible()
  }
  for (const state of ["Current", "Cached", "Stale", "Missing", "Unavailable"]) {
    // A stamp with a time reads "Current, 10:18", so the word may carry its comma.
    await expect(page.getByText(new RegExp(`^${state},?$`)).first()).toBeVisible()
  }
  await expect(page.locator("[data-rly-evidence-source]")).toHaveCount(5)
  await expect(page.locator("[data-rly-evidence-freshness]")).toHaveCount(5)
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("evidence-320.png") })
})

test("keeps named collaborator roles and controlled overflow clear at 320 pixels", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_200, width: 320 })
  await page.goto(story("patterns-peoplestrip--overflow"))

  const strip = page.getByRole("list", { exact: true, name: "Release collaborators" })
  await strip.getByRole("button", { name: "Show fewer people" }).click()
  await expect(strip.getByText("Avery Diaz")).toBeVisible()
  await expect(strip.getByText("PR author")).toBeVisible()
  const overflow = strip.getByRole("button", { name: "Show 2 more people" })
  await expect(overflow).toHaveText("+2 people")
  await overflow.click()
  await expect(strip.getByText("Emery van der Meer-Rodríguez with a deliberately long full name")).toBeVisible()
  await expect(strip.getByText("Merge approver")).toBeVisible()
  await expect(overflow).toHaveCount(0)
  await expect(strip.getByRole("button", { name: "Show fewer people" })).toHaveAttribute("aria-expanded", "true")
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("people-320.png") })
})

test(
  "keeps region headers on one rule and the content inside the frame at 320 pixels, in forced colors too",
  async ({ page }, testInfo) => {
    for (const forcedColors of ["auto", "active"]) {
      await page.setViewportSize({ height: 1_200, width: 320 })
      await page.goto(story("patterns-region--states", forcedColors))

      const findings = page.getByRole("region", { name: "Findings 2" })
      await expect(findings).toBeVisible()
      await expect(findings.getByRole("button", { name: "Acknowledge all" })).toBeVisible()
      const frame = await findings.boundingBox()
      const button = await findings.getByRole("button", { name: "Acknowledge all" }).boundingBox()
      expect(frame).not.toBeNull()
      expect(button).not.toBeNull()
      if (frame !== null && button !== null) expect(button.x + button.width).toBeLessThanOrEqual(frame.x + frame.width)
      const border = await findings.evaluate((element) => getComputedStyle(element).borderTopStyle)
      expect(border).toBe("solid")
      await expectNoHorizontalOverflow(page)
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: testInfo.outputPath(`region-320-${forcedColors}.png`)
      })
    }
  }
)

test(
  "keeps stage words inside 320 pixels, with ink on the blocking state and its weight kept in forced colors",
  async ({
    page
  }, testInfo) => {
    for (const forcedColors of ["auto", "active"]) {
      await page.setViewportSize({ height: 900, width: 320 })
      await page.goto(story("patterns-stagerail--words", forcedColors))

      const rail = page.getByRole("list", { name: "Relay 2.4 stages" })
      await expect(rail).toBeVisible()
      await expect(page.getByRole("region")).toHaveCount(0)
      await expect(rail.locator("[data-rly-stage-marker]")).toHaveCount(0)
      const style = (selector: string) =>
        rail
          .locator(selector)
          .first()
          .evaluate((element) => ({
            color: getComputedStyle(element).color,
            weight: Number(getComputedStyle(element).fontWeight)
          }))
      const [blocked, quiet] = await Promise.all([
        style("[data-rly-stage-word='blocked']"),
        style("[data-rly-stage-word='quiet']")
      ])
      expect(blocked.weight).toBeGreaterThanOrEqual(600)
      expect(quiet.weight).toBeLessThan(600)
      if (forcedColors === "auto") expect(blocked.color).not.toBe(quiet.color)
      await expectNoHorizontalOverflow(page)
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: testInfo.outputPath(`stage-words-320-${forcedColors}.png`)
      })
    }
  }
)

test(
  "keeps every hero size inside 320 pixels and the state word in its ink, in forced colors too",
  async ({ page }, testInfo) => {
    for (const forcedColors of ["auto", "active"]) {
      await page.setViewportSize({ height: 1_400, width: 320 })
      await page.goto(story("patterns-hero--states", forcedColors))

      await expect(page.getByRole("region", { name: "Work summary" })).toHaveText(/3 goals need you, 2 blocked/)
      const word = page.getByText("blocked", { exact: true }).first()
      await expect(word).toBeVisible()
      if (forcedColors === "auto") {
        const [wordInk, sentenceInk] = await word.evaluate((element) => [
          getComputedStyle(element).color,
          getComputedStyle(element.parentElement ?? element).color
        ])
        expect(wordInk).not.toBe(sentenceInk)
      } else {
        expect(await word.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe("underline")
      }
      await expectNoHorizontalOverflow(page)
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: testInfo.outputPath(`hero-320-${forcedColors}.png`)
      })
    }
  }
)

test(
  "keeps the decision target, both actions and the off reason inside 320 pixels, in forced colors too",
  async ({ page }, testInfo) => {
    for (const forcedColors of ["auto", "active"]) {
      await page.setViewportSize({ height: 1_200, width: 320 })
      await page.goto(story("patterns-decisionbar--states", forcedColors))

      const off = page.getByRole("button", { name: "Approve: Apply nix config to luna" })
      await expect(off).toHaveAttribute("aria-disabled", "true")
      await expect(off).toHaveAccessibleDescription(/hub is unreachable/)
      await off.focus()
      await expect(off).toBeFocused()
      if (forcedColors === "active") {
        expect(await off.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe("dashed")
      }
      await expect(page.getByText("Reassign Rotate signing keys from arch to arch-b, 4m 12s left")).toBeVisible()
      await expectNoHorizontalOverflow(page)
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: testInfo.outputPath(`decision-320-${forcedColors}.png`)
      })
    }
  }
)

test(
  "keeps every provenance shape distinct and labelled at 320 pixels, in forced colors too",
  async ({ page }, testInfo) => {
    for (const forcedColors of ["auto", "active"]) {
      await page.setViewportSize({ height: 1_400, width: 320 })
      await page.goto(story("patterns-timelinerow--provenance", forcedColors))

      const look = (kind: string) =>
        page.locator(`ol [data-rly-timeline-provenance='${kind}']`).evaluate((element) => {
          const css = getComputedStyle(element)
          return {
            clipped: css.clipPath !== "none",
            filled: css.backgroundColor !== "rgba(0, 0, 0, 0)" || css.backgroundImage !== "none",
            hatched: css.backgroundImage !== "none",
            rotated: css.rotate === "45deg",
            round: css.borderTopLeftRadius !== "0px"
          }
        })
      // Each shape stays distinct in both modes: that is what carries provenance without colour.
      expect(await look("auto")).toMatchObject({ clipped: false, filled: false, rotated: false, round: true })
      expect(await look("approved")).toMatchObject({ filled: true, hatched: false, rotated: false, round: true })
      expect(await look("pending")).toMatchObject({ filled: true, rotated: true })
      expect(await look("flag")).toMatchObject({ clipped: true, filled: true })
      expect(await look("unknown")).toMatchObject({ hatched: true, round: false })
      await expect(page.getByRole("list", { name: "Observation key" })).toBeVisible()
      await expect(page.getByText("Not applied: GitHub rate limit, retrying at 05:12")).toBeVisible()
      await expectNoHorizontalOverflow(page)
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: testInfo.outputPath(`timeline-provenance-320-${forcedColors}.png`)
      })
    }
  }
)

test("sizes verdict headlines to their column, so no word splits across lines", async ({ page }) => {
  for (const id of ["patterns-verdict--states", "patterns-entityshell--services"]) {
    for (const width of [1024, 1280, 1440, 390]) {
      await page.setViewportSize({ height: 900, width })
      await page.goto(story(id))
      await expect(page.locator("#storybook-root :is(h1, h2)").first()).toBeVisible()
      const split = await page.evaluate(() =>
        [...document.querySelectorAll("[class*='verdict'] h2, h2[class*='verdict'], [class*='verdict']")].flatMap(
          (element) => {
            const words: Array<string> = []
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
              for (const match of (node.textContent ?? "").matchAll(/\S+/g)) {
                const range = document.createRange()
                range.setStart(node, match.index)
                range.setEnd(node, match.index + match[0].length)
                if (new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size > 1) {
                  words.push(match[0])
                }
              }
            }
            return words
          }
        )
      )
      expect(split, `${id} at ${width}px`).toEqual([])
    }
  }
})

test("keeps revision hashes inside their fact cells at phone widths and in compact stories", async ({ page }) => {
  const stories = [
    "patterns-agentproposal--states",
    "patterns-agentproposal--compact-forced-colors",
    "patterns-governedactionreview--confirmation",
    "patterns-governedactionreview--terminal-states"
  ]
  for (const id of stories) {
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ height: 900, width })
      await page.goto(story(id))
      await expect(page.locator("dd").first()).toBeVisible()
      const overflowing = await page.evaluate(() =>
        [...document.querySelectorAll("dd")]
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => (element.textContent ?? "").slice(0, 24))
      )
      expect(overflowing, `${id} at ${width}px`).toEqual([])
    }
  }
})

test("keeps each relation phrase on one line in the chain and the table", async ({ page }) => {
  for (const id of ["patterns-relationshipchain--cardinalities", "patterns-relationshiptable--equivalence"]) {
    for (const width of [1280, 1024]) {
      await page.setViewportSize({ height: 900, width })
      await page.goto(story(id))
      await expect(page.locator("[data-rly-relationship-detail]").first()).toBeVisible()
      const wrapped = await page.evaluate(() =>
        // The direction phrase ("Implemented by") is the first span of the relation cell's first group.
        [...document.querySelectorAll("[data-rly-relationship-detail] > span:first-child > span:first-child")]
          .filter((element) => {
            const range = document.createRange()
            range.selectNodeContents(element)
            return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size > 1
          })
          .map((element) => element.textContent)
      )
      expect(wrapped, `${id} at ${width}px`).toEqual([])
    }
  }
})

test("never splits a provider name inside a service mark, at any width", async ({ page }) => {
  for (const id of ["patterns-servicemark--gallery", "patterns-evidencestamp--compact-forced-colors"]) {
    for (const width of [320, 390, 768, 1024, 1261, 1440]) {
      await page.setViewportSize({ height: 900, width })
      await page.goto(story(id))
      await expect(page.locator("#storybook-root [data-rly-service]").first()).toBeVisible()
      const split = await page.evaluate(() =>
        // The name span is the mark's last child; the glyph may sit on its own line in a stacked size.
        [...document.querySelectorAll("#storybook-root [data-rly-service] > span:last-child")].flatMap((name) => {
          const range = document.createRange()
          range.selectNodeContents(name)
          const lines = new Set(
            [...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top))
          )
          return lines.size > 1 ? [name.textContent ?? ""] : []
        })
      )
      expect(split, `${id} at ${width}px`).toEqual([])
    }
  }
})

test("keeps a region with an unbreakable title and body token inside 320 pixels", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_000, width: 320 })
  await page.goto(story("patterns-region--states"))
  const region = page.locator("[data-rly-region]").first()
  await expect(region).toBeVisible()
  // Application text can hold a token with no break point: a branch, an id, a path.
  await region.evaluate((element) => {
    const token = "feat/implementWorkCheckpointRecoveryAndReconciliationForTheFleetCoordinator"
    const title = element.querySelector("h2, h3")
    if (title !== null) title.textContent = token
    const body = element.lastElementChild
    if (body !== null) body.append(Object.assign(document.createElement("code"), { textContent: token }))
  })
  await expectNoHorizontalOverflow(page)
  const box = await region.boundingBox()
  expect(box?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(320)
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: testInfo.outputPath("region-unbreakable-320.png")
  })
})
