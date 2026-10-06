import { expect, type Page, test, type TestInfo } from "@playwright/test"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { readFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { exportGuide } from "../../dist/guide/export.js"

const patch = readFileSync("examples/approval-guide/guide.patch", "utf8")

/** The illustrative guide, optionally with one unbreakable identifier in its title and first chapter. */
const longPath = "packages/codecommit-web/src/client/components/sandbox-workspace-release-coordinator.ts"

/**
 * The illustrative guide. The long variant puts one unbreakable identifier in the title and first
 * chapter, and renames a diffed file to a long path, as real patches have in every file header.
 */
const guideHtml = (longIdentifiers = false) => {
  const rename = (text: string) => longIdentifiers ? text.replaceAll("src/release.ts", longPath) : text
  const guide = JSON.parse(rename(readFileSync("examples/approval-guide/guide.json", "utf8")))
  if (longIdentifiers) {
    guide.title = "Bind CodeCommitRevisionIdentifiersForSignedApprovalReleases to the approved revision"
    guide.sections[0].title = "verifySignedApprovalAgainstRequestedRevisionBeforeShipping"
  }
  const findings = JSON.parse(rename(readFileSync("examples/approval-guide/findings.json", "utf8")))
  if (longIdentifiers) {
    // A finding at an unbroken camelCase file, whose summary names an unbroken identifier.
    findings.issues[0].file = "src/verifySignedApprovalAgainstRequestedRevisionBeforeShipping.ts"
    findings.issues[0].summary = "`verifySignedApprovalAgainstRequestedRevisionBeforeShipping` ignores the revision."
  }
  return Effect.runPromise(exportGuide({ guide, findings, patch: rename(patch) })).then((page) => page.html)
}

const load = async (page: Page, html: string, testInfo: TestInfo) => {
  const file = testInfo.outputPath("guide.html")
  writeFileSync(file, html)
  await page.goto(pathToFileURL(file).href)
  await page.waitForFunction(() => document.documentElement.dataset.reviewReady === "true")
}

/** The part of a layout-shift entry the CLS sum needs. */
const LayoutShift = Schema.Struct({ value: Schema.Number, moved: Schema.Array(Schema.String) })

const diagramDrawn = (page: Page) => page.locator(".mermaid[data-processed=\"true\"] svg").waitFor()

for (const width of [320, 390]) {
  // QA-70: a long identifier in the title or a chapter name pushed the nav past the viewport.
  test(`long identifiers wrap inside the page at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 })
    await load(page, await guideHtml(true), testInfo)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
  })

  // Review finding: a long finding location or summary identifier widened the Review tab.
  test(`long finding paths and names wrap on the Review tab at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 })
    await load(page, await guideHtml(true), testInfo)
    await page.getByRole("tab", { name: /^Review/u }).click()
    await page.locator(".review-issue-location").first().waitFor()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
  })
}

/** The illustrative guide with a 20-step top-down flowchart, far taller than the diagram frame. */
const tallDiagramHtml = () => {
  const guide = JSON.parse(readFileSync("examples/approval-guide/guide.json", "utf8"))
  const steps = Array.from({ length: 20 }, (_, index) => `S${index}[Step ${index}]`)
  const chart = ["flowchart TD", ...steps.slice(1).map((step, index) => `${steps[index]} --> ${step}`)].join("\n")
  guide.sections[0].overview = `Before the diagram.\n\n\`\`\`mermaid\n${chart}\n\`\`\``
  const findings = JSON.parse(readFileSync("examples/approval-guide/findings.json", "utf8"))
  return Effect.runPromise(exportGuide({ guide, findings, patch })).then((page) => page.html)
}

// Review finding: centring an overflowing diagram put its top above the frame's scroll origin.
test("a diagram taller than its frame shows its first and last steps by scrolling", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await load(page, await tallDiagramHtml(), testInfo)
  await diagramDrawn(page)
  const frame = page.locator(".review-diagram .mermaid").first()
  const reach = (label: string) =>
    frame.evaluate((element, text) => {
      const node = [...element.querySelectorAll(".node")].find((candidate) => candidate.textContent?.trim() === text)
      if (node === undefined) return null
      const box = element.getBoundingClientRect()
      const rect = node.getBoundingClientRect()
      return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1
    }, label)
  expect(await reach("Step 0")).toBe(true)
  await frame.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  expect(await reach("Step 19")).toBe(true)

  await page.emulateMedia({ media: "print" })
  const clipped = await frame.evaluate((element) => element.scrollHeight - element.clientHeight)
  expect(clipped).toBeLessThanOrEqual(1)
})

// QA-71: callouts drew a 3px coloured bar on their inline-start edge.
test("callouts and panels draw no one-sided stripe", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await load(page, await guideHtml(), testInfo)
  const stripes = await page.locator("#review-root").evaluate((root) =>
    [...root.querySelectorAll("*")].flatMap((element) => {
      const style = getComputedStyle(element)
      const width = (side: string) =>
        style.getPropertyValue(`border-${side}-style`) === "none"
          ? 0
          : Number.parseFloat(style.getPropertyValue(`border-${side}-width`))
      const stripe = Math.abs(width("left") - width("right")) >= 2 || Math.abs(width("top") - width("bottom")) >= 2
      return stripe || style.boxShadow.includes("inset") ? [`${element.tagName}.${element.className}`] : []
    })
  )
  expect(stripes).toEqual([])
  await expect(page.locator(".callout").first()).toBeVisible()
})

// QA-76: dark-theme edge labels ("No", "Yes") sat in grey boxes below 4.5:1.
test("diagram edge labels reach 4.5:1 in the dark theme", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await page.setViewportSize({ width: 1280, height: 900 })
  await load(page, await guideHtml(), testInfo)
  await diagramDrawn(page)
  const ratios = await page.locator(".mermaid .edgeLabel").evaluateAll((labels) => {
    const rgb = (value: string) => {
      const probe = document.createElement("canvas").getContext("2d")!
      probe.fillStyle = value
      probe.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
      return { r: r!, g: g!, b: b!, a: a! }
    }
    const luminance = ({ b, g, r }: { r: number; g: number; b: number }) =>
      [r, g, b]
        .map((channel) => channel / 255)
        .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0)
    return labels.flatMap((label) => {
      const text = label.querySelector("p, span, text") ?? label
      if ((text.textContent ?? "").trim() === "") return []
      let behind: Element | null = text
      let background = rgb("transparent")
      while (behind !== null && background.a === 0) {
        background = rgb(getComputedStyle(behind).backgroundColor)
        behind = behind.parentElement
      }
      const ink = getComputedStyle(text)
      const color = text.namespaceURI === "http://www.w3.org/2000/svg" ? ink.fill : ink.color
      const [light, dark] = [luminance(rgb(color)), luminance(background)].sort((a, b) => b - a)
      return [(light! + 0.05) / (dark! + 0.05)]
    })
  })
  expect(ratios.length).toBeGreaterThan(0)
  for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5)
})

for (const width of [1024, 1440]) {
  // QA-80: the diagram drew after first paint without reserved height and pushed the page down.
  test(`drawing the diagram shifts nothing at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await load(page, await guideHtml(), testInfo)
    await diagramDrawn(page)
    await page.waitForTimeout(300)
    // Buffered entries include every shift since navigation, before and after the diagram drew.
    const entries = await page.evaluate(() =>
      new Promise<Array<unknown>>((resolve) => {
        new PerformanceObserver((list, observer) => {
          observer.disconnect()
          resolve(
            list.getEntries().map((entry) => ({
              ...entry.toJSON(),
              // Which elements moved, for the failure message.
              moved: ("sources" in entry && Array.isArray(entry.sources) ? entry.sources : []).map((source) =>
                String(source?.node?.nodeName ?? "") + "." + String(source?.node?.className ?? "") + " " +
                JSON.stringify([source?.previousRect?.y, source?.previousRect?.height, source?.currentRect?.y])
              )
            }))
          )
        }).observe({ type: "layout-shift", buffered: true })
        setTimeout(() => resolve([]), 500)
      })
    )
    const total = Schema.decodeUnknownSync(Schema.Array(LayoutShift))(entries).reduce(
      (sum, entry) => sum + entry.value,
      0
    )
    expect(total, JSON.stringify(Schema.decodeUnknownSync(Schema.Array(LayoutShift))(entries))).toBeLessThan(0.05)
  })
}
