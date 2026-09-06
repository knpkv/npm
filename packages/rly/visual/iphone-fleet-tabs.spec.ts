import { expect, test } from "@playwright/test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const story =
  "/iframe.html?id=primitives-tabs--fleet-mobile&viewMode=story&globals=theme:dark;forcedColors:auto;reducedMotion:reduce;locale:en;density:comfortable"

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
    expect(await list.evaluate((element) => getComputedStyle(element).zIndex)).toBe("auto")

    const work = list.getByRole("tab", { name: "Work" })
    await terminalInput.focus()
    await expect(terminalInput).toBeFocused()
    await work.click()
    await expect(work).toHaveAttribute("aria-selected", "true")
  })
}
