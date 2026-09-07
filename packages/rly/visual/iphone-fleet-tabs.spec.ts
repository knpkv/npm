import { expect, test } from "@playwright/test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const story =
  "/iframe.html?id=primitives-tabs--fleet-mobile&viewMode=story&globals=theme:dark;forcedColors:auto;reducedMotion:reduce;locale:en;density:comfortable"
const stackedStory =
  "/iframe.html?id=primitives-tabs--stacked-mobile&viewMode=story&globals=theme:dark;forcedColors:auto;reducedMotion:reduce;locale:en;density:comfortable"
const stackedForcedColorsStory =
  "/iframe.html?id=primitives-tabs--stacked-mobile&viewMode=story&globals=theme:dark;forcedColors:active;reducedMotion:reduce;locale:en;density:comfortable"

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))
const workspaceRoot = resolve(packageRoot, "../..")
const connectorCss = readFileSync(resolve(workspaceRoot, "packages/herdr-connect/src/styles.css"), "utf8").replace(
  "@import \"@knpkv/rly/styles.css\";",
  ""
)
const approvalsCss = readFileSync(resolve(workspaceRoot, "packages/herdr-approvals/src/styles.css"), "utf8")

const mobileViewports = [
  { height: 844, width: 390 },
  { height: 500, width: 393 }
] satisfies ReadonlyArray<{ readonly height: number; readonly width: number }>

test("393x500 stacked selection has no scrollbar-like line", async ({ page }) => {
  await page.setViewportSize({ height: 500, width: 393 })
  await page.goto(stackedStory)

  const list = page.getByRole("tablist", { name: "Stacked sections" })
  const tabs = list.getByRole("tab")
  const selected = list.getByRole("tab", { name: "Connect", selected: true })
  await expect(tabs).toHaveCount(3)
  await expect(list).toHaveCSS("width", "329px")

  const rows = await tabs.evaluateAll((elements) =>
    elements.map((element) => Math.round(element.getBoundingClientRect().y))
  )
  expect(new Set(rows).size).toBe(3)
  const [listBackground, selectedBackground] = await Promise.all([
    list.evaluate((element) => getComputedStyle(element).backgroundColor),
    selected.evaluate((element) => getComputedStyle(element).backgroundColor)
  ])
  expect(selectedBackground).not.toBe(listBackground)

  const indicator = await selected.evaluate((element) => {
    const style = getComputedStyle(element, "::after")
    return { content: style.content, height: style.height, position: style.position, width: style.width }
  })
  expect(indicator.content).toBe("none")

  await page.keyboard.press("Tab")
  await expect(selected).toBeFocused()
  await expect(selected).toHaveCSS("outline-style", "solid")
  await expect(selected).toHaveCSS("outline-width", "3px")
  await expect(page.getByRole("tabpanel", { name: "Connect" })).toContainText("Connected terminal")
})

test("desktop stacked selection keeps its indicator", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 1280 })
  await page.goto(stackedStory)

  const selected = page.getByRole("tablist", { name: "Stacked sections" }).getByRole("tab", {
    name: "Connect",
    selected: true
  })
  const indicator = await selected.evaluate((element) => {
    const style = getComputedStyle(element, "::after")
    return { content: style.content, height: style.height, position: style.position, width: style.width }
  })

  expect(indicator).toEqual({ content: "\"\"", height: "2px", position: "absolute", width: "297px" })
})

test("393x500 stacked selection keeps its forced-colors cue", async ({ page }) => {
  await page.setViewportSize({ height: 500, width: 393 })
  const selected = page.getByRole("tablist", { name: "Stacked sections" }).getByRole("tab", {
    name: "Connect",
    selected: true
  })
  const indicatorContent = () => selected.evaluate((element) => getComputedStyle(element, "::after").content)

  await page.goto(stackedForcedColorsStory)
  expect(await indicatorContent()).toBe("\"\"")

  await page.emulateMedia({ forcedColors: "active" })
  await page.goto(stackedStory)
  expect(await indicatorContent()).toBe("\"\"")
})

for (const viewport of mobileViewports) {
  test(`${String(viewport.width)}x${String(viewport.height)} keeps application tabs in one pointer-navigable row`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto(story)

    const list = page.getByRole("tablist", { name: "Fleet applications" })
    const tabs = list.getByRole("tab")
    await expect(tabs).toHaveCount(3)
    const boxes = await tabs.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()))

    expect(new Set(boxes.map(({ y }) => Math.round(y))).size).toBe(1)
    expect(Math.round((await list.boundingBox())?.height ?? 0)).toBeLessThanOrEqual(64)

    await page.addStyleTag({ content: `${connectorCss}\n${approvalsCss}` })
    const listBox = await list.boundingBox()
    if (listBox === null) throw new Error("fleet tab list is missing")
    await page.evaluate((tabBottom) => {
      document.body.classList.add("fleet-shell-main")
      document.body.style.setProperty("--fleet-shell-tab-bottom", `${String(tabBottom)}px`)
      const terminal = document.createElement("div")
      terminal.className = "connect-shell connect-shell-embedded"
      terminal.innerHTML = `
        <div class="connect-workspace" data-mode="terminal">
          <div aria-hidden="true" class="connect-directory-screen" inert></div>
          <div aria-label="Agent terminal" class="connect-terminal-screen">
            <section class="terminal-stage">
              <div class="terminal-bar">Connected terminal</div>
              <textarea aria-label="Terminal input"></textarea>
            </section>
          </div>
        </div>`
      document.body.append(terminal)
    }, listBox.y + listBox.height)

    const terminal = page.getByLabel("Agent terminal").first()
    const terminalInput = page.getByRole("textbox", { name: "Terminal input" })
    const terminalBox = await terminal.boundingBox()
    expect(terminalBox?.y ?? 0).toBeGreaterThanOrEqual(listBox.y + listBox.height)
    const nestedTerminalBox = await terminal.evaluate((element) => {
      const activePanel = document.querySelector<HTMLElement>("[role=tabpanel][data-state=active]")
      if (activePanel === null) throw new Error("active Fleet tab panel is missing")
      const connectShell = element.closest<HTMLElement>(".connect-shell")
      if (connectShell === null) throw new Error("Connect shell is missing")
      activePanel.append(connectShell)
      return element.getBoundingClientRect()
    })
    const visualViewportBottom = await page.evaluate(
      () => (window.visualViewport?.offsetTop ?? 0) + (window.visualViewport?.height ?? window.innerHeight)
    )
    expect(Math.abs(nestedTerminalBox.y - (listBox.y + listBox.height))).toBeLessThanOrEqual(1)
    expect(Math.abs(nestedTerminalBox.bottom - visualViewportBottom)).toBeLessThanOrEqual(1)
    expect(await list.evaluate((element) => getComputedStyle(element).zIndex)).toBe("auto")

    const work = list.getByRole("tab", { name: "Work" })
    await terminalInput.focus()
    await expect(terminalInput).toBeFocused()
    await work.click()
    await expect(work).toHaveAttribute("aria-selected", "true")
  })
}
