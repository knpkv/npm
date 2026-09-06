import { expect, type Page, test } from "@playwright/test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const workspaceRoot = resolve(packageRoot, "../..")
const readCss = (path: string): string => readFileSync(path, "utf8")
const connectorCss = readCss(resolve(packageRoot, "src/styles.css")).replace("@import \"@knpkv/rly/styles.css\";", "")
const terminalViewportSource = transpileModule(readFileSync(resolve(packageRoot, "src/terminal-viewport.ts"), "utf8"), {
  compilerOptions: {
    module: ModuleKind.ESNext,
    target: ScriptTarget.ES2022
  }
}).outputText
const workspaceFocusSource = transpileModule(readFileSync(resolve(packageRoot, "src/workspace-focus.ts"), "utf8"), {
  compilerOptions: {
    module: ModuleKind.ESNext,
    target: ScriptTarget.ES2022
  }
}).outputText

declare global {
  interface Window {
    bindTerminalViewport?: (target: HTMLElement, host: Window, topBoundary: HTMLElement) => () => void
    releaseTerminalViewport?: () => void
    terminalViewportBindingActive?: (state: {
      readonly connectionRequested: boolean
      readonly focusRejected: boolean
      readonly terminalConnected: boolean
    }) => boolean
    enterTerminalWorkspace?: (
      elements: {
        readonly directory: HTMLElement
        readonly terminal: HTMLElement
        readonly workspace: HTMLElement
      },
      focusTarget: HTMLElement
    ) => { readonly _tag: string }
    returnToDirectoryWorkspace?: (
      elements: {
        readonly directory: HTMLElement
        readonly terminal: HTMLElement
        readonly workspace: HTMLElement
      },
      focusTarget: HTMLElement
    ) => { readonly _tag: string }
  }
}

const fixtureCss = [
  readCss(resolve(workspaceRoot, "packages/rly/src/styles/generated-tokens.css")),
  readCss(resolve(workspaceRoot, "packages/rly/src/styles/base.css")),
  readCss(resolve(workspaceRoot, "packages/rly/src/primitives/Tabs.module.css")),
  connectorCss,
  readCss(resolve(workspaceRoot, "packages/herdr-approvals/src/styles.css")),
  `
    html, body { margin: 0; }
    *, *::before, *::after { box-sizing: border-box; }
    .fleet-shell-masthead { block-size: 72px; }
    .fixture-tabs-list { block-size: 156px; }
    .fixture-tabs-panel { padding-block-start: 0; }
    .fixture-state { border: 1px solid currentcolor; padding: 4px 8px; }
  `
].join("\n")

const setKeyboardTerminal = async (page: Page): Promise<void> => {
  await page.setViewportSize({ height: 500, width: 393 })
  await page.setContent(`
    <!doctype html>
    <html data-rly-root data-rly-theme="dark">
      <head><style>${fixtureCss}</style></head>
      <body data-rly-root>
        <div class="fleet-shell">
          <header class="fleet-shell-masthead"><strong>Herdr</strong><span>3 configured hosts</span></header>
          <main class="fleet-shell-main">
            <div class="root large">
              <div aria-label="Fleet applications" class="list fixture-tabs-list" role="tablist">
                <button class="trigger" role="tab" type="button">Approvals</button>
                <button class="trigger" data-state="active" role="tab" type="button">Connect</button>
                <button class="trigger" role="tab" type="button">Work</button>
              </div>
              <div class="panel fixture-tabs-panel" role="tabpanel">
                <div class="connect-shell connect-shell-embedded" data-terminal-top-boundary>
                  <div class="connect-workspace" data-mode="terminal">
                    <div aria-hidden="true" class="connect-directory-screen" inert tabindex="-1"><button data-retained-agent>host-coordinator</button></div>
                    <div aria-label="Agent terminal" class="connect-terminal-screen">
                      <section class="terminal-stage">
                        <div class="terminal-bar">
                          <button class="terminal-back" type="button">Agents</button>
                          <div><strong>host-coordinator</strong><small>SER8 · codex</small></div>
                          <span class="fixture-state">connected</span>
                        </div>
                        <div aria-label="Terminal keyboard controls" class="terminal-key-rail" role="toolbar">
                          <div class="terminal-key-scroll"><button class="terminal-key" type="button">Ctrl</button><button class="terminal-key" type="button">Esc</button><button class="terminal-key" type="button">Tab</button></div>
                          <small class="terminal-key-error"></small>
                        </div>
                        <div aria-label="Agent terminal" class="ghostty-terminal">
                          <label><span data-terminal-prompt>&gt;</span> <textarea aria-label="Terminal input">typed text</textarea></label>
                        </div>
                      </section>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </main>
        </div>
      </body>
    </html>`)
  await page.addScriptTag({
    content:
      `${terminalViewportSource}\nwindow.bindTerminalViewport = bindTerminalViewport\nwindow.terminalViewportBindingActive = terminalViewportBindingActive`,
    type: "module"
  })
  await page.evaluate(() => {
    const terminal = document.querySelector<HTMLElement>(".connect-terminal-screen")
    const boundary = document.querySelector<HTMLElement>("[data-terminal-top-boundary]")
    const bind = window.bindTerminalViewport
    if (terminal === null || boundary === null || bind === undefined) {
      throw new Error("terminal viewport fixture missing")
    }
    window.releaseTerminalViewport = bind(terminal, window, boundary)
  })
}

test("393x500 keeps the embedded terminal below Fleet navigation and above the software keyboard", async ({ page }) => {
  await setKeyboardTerminal(page)

  const navigation = page.getByRole("tablist", { name: "Fleet applications" })
  const terminal = page.locator(".connect-terminal-screen")
  const terminalHeader = page.locator(".terminal-bar")
  const keyRail = page.getByRole("toolbar", { name: "Terminal keyboard controls" })
  const prompt = page.locator("[data-terminal-prompt]")
  const input = page.getByRole("textbox", { name: "Terminal input" })
  const navigationBox = await navigation.boundingBox()
  const terminalBox = await terminal.boundingBox()

  expect(navigationBox).not.toBeNull()
  expect(terminalBox).not.toBeNull()
  expect(terminalBox?.y).toBeGreaterThanOrEqual((navigationBox?.y ?? 0) + (navigationBox?.height ?? 0))
  expect((terminalBox?.y ?? 500) + (terminalBox?.height ?? 0)).toBeLessThanOrEqual(500)
  await expect(terminalHeader).toBeVisible()
  await expect(keyRail).toBeVisible()
  await expect(prompt).toBeVisible()
  await expect(input).toBeVisible()
  await expect(input).toHaveValue("typed text")

  await page.addScriptTag({
    content: `${workspaceFocusSource}\nwindow.returnToDirectoryWorkspace = returnToDirectoryWorkspace`,
    type: "module"
  })
  const retainedGeometry = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".connect-workspace")
    const directory = document.querySelector<HTMLElement>(".connect-directory-screen")
    const terminal = document.querySelector<HTMLElement>(".connect-terminal-screen")
    const shell = document.querySelector<HTMLElement>(".connect-shell")
    const agent = document.querySelector<HTMLButtonElement>("[data-retained-agent]")
    const back = document.querySelector<HTMLButtonElement>(".terminal-back")
    const leave = window.returnToDirectoryWorkspace
    const bindingActive = window.terminalViewportBindingActive
    if (
      workspace === null ||
      directory === null ||
      terminal === null ||
      shell === null ||
      agent === null ||
      back === null ||
      leave === undefined ||
      bindingActive === undefined
    ) {
      throw new Error("retained terminal fixture missing")
    }
    agent.disabled = true
    directory.focus = () => undefined
    workspace.focus = () => undefined
    shell.focus = () => undefined
    back.focus()
    const transition = leave({ directory, terminal, workspace }, agent)
    const remainsActive = bindingActive({
      connectionRequested: false,
      focusRejected: transition._tag === "failed",
      terminalConnected: false
    })
    if (!remainsActive) window.releaseTerminalViewport?.()
    return {
      height: terminal.style.getPropertyValue("--connect-visual-viewport-height"),
      mode: workspace.dataset.mode,
      offset: terminal.style.getPropertyValue("--connect-visual-viewport-offset"),
      remainsActive
    }
  })
  expect(retainedGeometry).toEqual({ height: "248px", mode: "terminal", offset: "252px", remainsActive: true })
})

test("terminal transitions move focus before hiding either screen", async ({ page }) => {
  const ariaWarnings: Array<string> = []
  page.on("console", (message) => {
    if (message.type() === "warning" && message.text().includes("aria-hidden")) ariaWarnings.push(message.text())
  })
  await page.setViewportSize({ height: 852, width: 393 })
  await page.setContent(`
    <div class="connect-shell" tabindex="-1">
      <div class="connect-workspace" data-mode="directory" tabindex="-1">
        <div aria-hidden="false" class="connect-directory-screen" tabindex="-1"><button data-agent-key="SER8:agent-01">agent-01</button></div>
        <div aria-hidden="true" class="connect-terminal-screen" inert><button class="terminal-back">Agents</button><small data-focus-rejection-message role="alert">Terminal focus transition failed · focus_rejected</small></div>
      </div>
    </div>`)
  await page.addScriptTag({
    content:
      `${workspaceFocusSource}\nwindow.enterTerminalWorkspace = enterTerminalWorkspace\nwindow.returnToDirectoryWorkspace = returnToDirectoryWorkspace`,
    type: "module"
  })

  const result = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".connect-workspace")
    const directory = document.querySelector<HTMLElement>(".connect-directory-screen")
    const terminal = document.querySelector<HTMLElement>(".connect-terminal-screen")
    const shell = document.querySelector<HTMLElement>(".connect-shell")
    const agent = document.querySelector<HTMLButtonElement>("[data-agent-key]")
    const back = document.querySelector<HTMLButtonElement>(".terminal-back")
    const enter = window.enterTerminalWorkspace
    const leave = window.returnToDirectoryWorkspace
    if (
      workspace === null ||
      directory === null ||
      terminal === null ||
      shell === null ||
      agent === null ||
      back === null ||
      enter === undefined ||
      leave === undefined
    ) {
      throw new Error("workspace focus fixture missing")
    }
    let directoryStateWhenAgentBlurred: { readonly ariaHidden: string | null; readonly inert: boolean } | null = null
    let terminalStateWhenBackBlurred: { readonly ariaHidden: string | null; readonly inert: boolean } | null = null
    agent.addEventListener("blur", () => {
      directoryStateWhenAgentBlurred = { ariaHidden: directory.getAttribute("aria-hidden"), inert: directory.inert }
    })
    back.addEventListener("blur", () => {
      terminalStateWhenBackBlurred = { ariaHidden: terminal.getAttribute("aria-hidden"), inert: terminal.inert }
    })

    agent.focus()
    const entered = enter({ directory, terminal, workspace }, back)
    const terminalFocus = document.activeElement === back
    const terminalMode = workspace.dataset.mode
    const directoryHidden = directory.ariaHidden
    const directoryInert = directory.inert
    const returned = leave({ directory, terminal, workspace }, agent)
    const restoredAgentFocus = document.activeElement === agent
    agent.disabled = true
    const reentered = enter({ directory, terminal, workspace }, back)
    const fallbackReturn = leave({ directory, terminal, workspace }, agent)
    const directoryFallbackFocus = document.activeElement === directory
    const reenteredForRejection = enter({ directory, terminal, workspace }, back)
    directory.focus = () => undefined
    workspace.focus = () => undefined
    const rejectedReturn = leave({ directory, terminal, workspace }, agent)
    const shellFocusAfterRejectedReturn = document.activeElement === shell
    const reenteredForTotalRejection = enter({ directory, terminal, workspace }, back)
    shell.focus = () => undefined
    const totallyRejectedReturn = leave({ directory, terminal, workspace }, agent)

    return {
      shellFocusAfterRejectedReturn,
      directoryFallbackFocus,
      directoryModeAfterRejectedFocus: workspace.dataset.mode,
      directoryHidden,
      directoryInert,
      directoryStateWhenAgentBlurred,
      entered,
      fallbackReturn,
      reentered,
      reenteredForRejection,
      reenteredForTotalRejection,
      rejectedReturn,
      returned,
      terminalFocus,
      terminalFocusAfterTotalRejection: document.activeElement === back,
      terminalMode,
      terminalStateWhenBackBlurred,
      restoredAgentFocus,
      terminalHidden: terminal.ariaHidden,
      terminalInert: terminal.inert,
      totallyRejectedReturn
    }
  })

  expect(result).toEqual({
    shellFocusAfterRejectedReturn: true,
    directoryFallbackFocus: true,
    directoryModeAfterRejectedFocus: "terminal",
    directoryHidden: "true",
    directoryInert: true,
    directoryStateWhenAgentBlurred: { ariaHidden: "false", inert: false },
    entered: { _tag: "moved" },
    fallbackReturn: { _tag: "moved" },
    reentered: { _tag: "moved" },
    reenteredForRejection: { _tag: "moved" },
    reenteredForTotalRejection: { _tag: "moved" },
    rejectedReturn: { _tag: "moved" },
    returned: { _tag: "moved" },
    terminalFocus: true,
    terminalFocusAfterTotalRejection: true,
    terminalMode: "terminal",
    terminalStateWhenBackBlurred: { ariaHidden: "false", inert: false },
    restoredAgentFocus: true,
    terminalHidden: "false",
    terminalInert: false,
    totallyRejectedReturn: { _tag: "failed", reason: "focus_rejected" }
  })
  await expect(page.getByRole("alert")).toBeVisible()
  expect(ariaWarnings).toEqual([])
})

test("detached focus targets leave terminal mode unchanged", async ({ page }) => {
  await page.setViewportSize({ height: 852, width: 393 })
  await page.setContent(`
    <div class="connect-shell" tabindex="-1">
      <div class="connect-workspace" data-mode="terminal" tabindex="-1">
        <div aria-hidden="true" class="connect-directory-screen" inert tabindex="-1"></div>
        <div aria-hidden="false" class="connect-terminal-screen"><button class="terminal-back">Agents</button></div>
      </div>
    </div>`)
  await page.addScriptTag({
    content: `${workspaceFocusSource}\nwindow.returnToDirectoryWorkspace = returnToDirectoryWorkspace`,
    type: "module"
  })

  const result = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".connect-workspace")
    const directory = document.querySelector<HTMLElement>(".connect-directory-screen")
    const terminal = document.querySelector<HTMLElement>(".connect-terminal-screen")
    const back = document.querySelector<HTMLButtonElement>(".terminal-back")
    const leave = window.returnToDirectoryWorkspace
    if (workspace === null || directory === null || terminal === null || back === null || leave === undefined) {
      throw new Error("detached focus fixture missing")
    }
    terminal.remove()
    const transition = leave({ directory, terminal, workspace }, back)
    return {
      directoryHidden: directory.ariaHidden,
      directoryInert: directory.inert,
      mode: workspace.dataset.mode,
      transition
    }
  })

  expect(result).toEqual({
    directoryHidden: "true",
    directoryInert: true,
    mode: "terminal",
    transition: { _tag: "failed", reason: "detached_element" }
  })
})

test("embedded terminal geometry follows nested Fleet scrolling", async ({ page }) => {
  await page.setViewportSize({ height: 852, width: 393 })
  await page.setContent(`
    <style>html, body { margin: 0; } #fleet-scroll { block-size: 180px; overflow: auto; } .spacer { block-size: 80px; } .content { block-size: 400px; }</style>
    <div id="fleet-scroll"><div class="spacer"></div><div class="content"><div data-terminal-top-boundary></div></div></div>
    <div class="connect-terminal-screen"></div>`)
  await page.addScriptTag({
    content: `${terminalViewportSource}\nwindow.bindTerminalViewport = bindTerminalViewport`,
    type: "module"
  })
  await page.evaluate(() => {
    const terminal = document.querySelector<HTMLElement>(".connect-terminal-screen")
    const boundary = document.querySelector<HTMLElement>("[data-terminal-top-boundary]")
    const bind = window.bindTerminalViewport
    if (terminal === null || boundary === null || bind === undefined) {
      throw new Error("nested scroll fixture missing")
    }
    bind(terminal, window, boundary)
  })

  await expect(page.locator(".connect-terminal-screen")).toHaveCSS("--connect-visual-viewport-offset", "80px")
  await page.locator("#fleet-scroll").evaluate((element) => {
    element.scrollTop = 40
  })
  await expect(page.locator(".connect-terminal-screen")).toHaveCSS("--connect-visual-viewport-offset", "40px")
})

const setMobileDirectoryFilters = async (
  page: Page,
  viewport: { readonly height: number; readonly width: number }
): Promise<void> => {
  const longHost = "iphone-connect-".repeat(18).slice(0, 253)
  await page.setViewportSize(viewport)
  await page.setContent(`
    <!doctype html>
    <html data-rly-root data-rly-theme="dark">
      <head><style>${fixtureCss}</style></head>
      <body data-rly-root>
        <section class="connect-agents" aria-label="Herdr agents">
          <label class="connect-search"><span>Find agent</span><input type="search"></label>
          <div class="connect-filter-row">
            <div class="connect-filter-set">
              <span class="connect-filter-label" id="fixture-host-filter">Host</span>
              <div aria-labelledby="fixture-host-filter" class="connect-group-filter" role="group">
                <button aria-pressed="true">All hosts</button><button>SER8</button><button>PI-4</button><button data-long-host>${longHost}</button>
              </div>
            </div>
            <div class="connect-filter-set">
              <span class="connect-filter-label" id="fixture-status-filter">Status</span>
              <div aria-labelledby="fixture-status-filter" class="connect-status-filter" role="group">
                <button aria-pressed="true">All</button><button>Working</button><button>Attention</button><button>Ready</button><button>Finished</button>
              </div>
            </div>
          </div>
          <div class="connect-agent-list">
            <button class="connect-agent">agent-01</button><button class="connect-agent">agent-02</button><button class="connect-agent">agent-03</button>
          </div>
        </section>
      </body>
    </html>`)
}

for (
  const viewport of [
    { height: 844, width: 390 },
    { height: 852, width: 393 }
  ]
) {
  test(`${String(viewport.width)}x${String(viewport.height)} exposes every host and status filter`, async ({ page }) => {
    await setMobileDirectoryFilters(page, viewport)

    const filterRow = page.locator(".connect-filter-row")
    const buttons = filterRow.getByRole("button")
    await expect(page.getByText("Host", { exact: true })).toBeVisible()
    await expect(page.getByText("Status", { exact: true })).toBeVisible()
    await expect(buttons).toHaveCount(9)
    expect(await filterRow.evaluate((element) => getComputedStyle(element).overflowX)).toBe("visible")
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0)
    const longHost = page.locator("[data-long-host]")
    const longHostBox = await longHost.boundingBox()
    expect(longHostBox).not.toBeNull()
    expect((longHostBox?.x ?? viewport.width) + (longHostBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width)
    expect(
      await page.locator(".connect-group-filter").evaluate((element) => element.scrollWidth - element.clientWidth)
    ).toBe(0)
    for (const button of await buttons.all()) await expect(button).toBeInViewport()

    await buttons.first().focus()
    for (let index = 1; index < 9; index += 1) {
      await page.keyboard.press("Tab")
      await expect(buttons.nth(index)).toBeFocused()
    }
    await expect(page.locator(".connect-agent")).toHaveCount(3)
  })
}
