import { expect, type Page, test } from "@playwright/test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const workspaceRoot = resolve(packageRoot, "../..")
const readCss = (path: string): string => readFileSync(path, "utf8")
const connectorCss = readCss(resolve(packageRoot, "src/styles.css")).replace(
  "@import \"@knpkv/rly/styles.css\";",
  ""
)
const terminalRailNavigationSource = transpileModule(
  readFileSync(resolve(packageRoot, "src/terminal-rail-navigation.ts"), "utf8"),
  {
    compilerOptions: {
      module: ModuleKind.ESNext,
      target: ScriptTarget.ES2022
    }
  }
).outputText

declare global {
  interface Window {
    nextTerminalRailIndex?: (key: string, currentIndex: number, enabled: ReadonlyArray<boolean>) => number | null
  }
}
const fixtureCss = [
  readCss(resolve(workspaceRoot, "packages/rly/src/styles/generated-tokens.css")),
  readCss(resolve(workspaceRoot, "packages/rly/src/styles/base.css")),
  readCss(resolve(workspaceRoot, "packages/rly/src/primitives/Text.module.css")),
  connectorCss,
  `
    html, body { margin: 0; }
    *, *::before, *::after { box-sizing: border-box; }
    .fixture-offset { block-size: 10rem; }
    .fixture-standalone-header { inset-block-start: 0; inset-inline: 0; position: absolute; }
    @layer rly.components {
      .fixture-page-title {
        font: var(--rly-type-page-title-weight) var(--rly-type-page-title-size) / var(--rly-type-page-title-line-height)
          var(--rly-type-page-title-font);
        letter-spacing: var(--rly-type-page-title-tracking);
        margin: 0;
      }
    }
    .fixture-meta { font: var(--rly-type-meta-weight) var(--rly-type-meta-size) / var(--rly-type-meta-line-height) var(--rly-type-meta-font); }
    .fixture-state {
      border: 1px solid currentcolor;
      border-radius: var(--rly-radius-tag);
      color: var(--rly-color-success-ink);
      display: inline-flex;
      font: var(--rly-type-meta-weight) var(--rly-type-meta-size) / var(--rly-type-meta-line-height) var(--rly-type-meta-font);
      padding: var(--rly-space-4) var(--rly-space-8);
    }
    .agent-presence { block-size: var(--rly-space-6); inline-size: var(--rly-space-6); border-radius: var(--rly-radius-round); }
  `
].join("\n")

const agentRows = Array.from({ length: 18 }, (_, index) => {
  const agent = String(index + 1).padStart(2, "0")
  return `
    <button class="connect-agent" type="button">
      <time>12:${agent}</time>
      <span class="agent-presence"></span>
      <span class="connect-agent-copy"><strong>agent-${agent}</strong><small>SER8 · Root agent · Working in npm</small></span>
      <span class="fixture-state">working</span>
    </button>`
}).join("")

const directory = `
  <section class="connect-agents" aria-label="Herdr agents">
    <label class="connect-search"><span>Find agent</span><input placeholder="Name, host, state…" type="search"></label>
    <div class="connect-filter-row">
      <div class="connect-group-filter"><button aria-pressed="true">All hosts</button><button>SER8</button></div>
      <div class="connect-status-filter"><button aria-pressed="true">All</button><button>Working</button><button>Attention</button><button>Ready</button><button>Finished</button></div>
    </div>
    <div class="connect-agent-tree">
      <div>
        <header class="connect-day-heading"><div><strong>Today</strong><span>Monday, 31 August</span></div><small data-agent-count>18 agents</small></header>
        <div class="connect-agent-list">${agentRows}</div>
      </div>
    </div>
  </section>`

const setEmbeddedDirectory = (page: Page): Promise<void> =>
  page.setContent(`
    <!doctype html>
    <html data-rly-root data-rly-theme="dark">
      <head><style>${fixtureCss}</style></head>
      <body>
        <header class="connect-header fixture-standalone-header">
          <div><span class="fixture-meta">Herdr fleet</span><h1 class="fixture-page-title">Connect</h1></div>
          <nav class="fleet-app-nav" aria-label="Fleet applications"><a href="/">Approvals</a><a aria-current="page" href="/connect/">Connect</a></nav>
        </header>
        <div class="fixture-offset"></div>
        <div class="connect-shell connect-shell-embedded">
          <div class="connect-workspace" data-mode="directory">
            <div class="connect-directory-screen">
              <header class="connect-embedded-intro">
                <div><span class="fixture-meta">Live fleet directory</span><h1 class="fixture-page-title">Connect to an agent</h1><p>Choose a worker, reviewer, or coordinator to open its exact terminal.</p></div>
                <span class="fixture-state">18 agents</span>
              </header>
              ${directory}
            </div>
          </div>
        </div>
      </body>
    </html>`)

const setStandaloneDirectory = (page: Page): Promise<void> =>
  page.setContent(`
    <!doctype html>
    <html data-rly-root data-rly-theme="dark">
      <head><style>${fixtureCss}</style></head>
      <body class="connect-body">
        <div class="connect-shell">
          <div class="connect-workspace" data-mode="directory">
            <div class="connect-directory-screen">
              <header class="connect-header">
                <div><span class="fixture-meta">Herdr fleet</span><h1 class="fixture-page-title">Connect</h1></div>
                <nav class="fleet-app-nav" aria-label="Fleet applications"><a href="/">Approvals</a><a aria-current="page" href="/connect/">Connect</a></nav>
              </header>
              ${directory}
            </div>
          </div>
        </div>
      </body>
    </html>`)

const terminalRail = `
  <div aria-label="Terminal keyboard controls" class="terminal-key-rail" data-terminal-key-rail role="toolbar">
    <div class="terminal-key-scroll">
      <div aria-label="Terminal modifiers" class="terminal-key-group" role="group">
        <button aria-pressed="false" class="terminal-key terminal-key-modifier" data-terminal-key="ctrl" tabindex="0" type="button">Ctrl</button>
        <button aria-pressed="false" class="terminal-key terminal-key-modifier" data-terminal-key="alt" tabindex="-1" type="button">Alt</button>
      </div>
      <div aria-label="Terminal keys" class="terminal-key-group" role="group">
        <button aria-label="Escape" class="terminal-key" data-terminal-key="escape" tabindex="-1" type="button">Esc</button>
        <button aria-label="Tab" class="terminal-key" data-terminal-key="tab" tabindex="-1" type="button">Tab</button>
        <button aria-label="Arrow left" class="terminal-key" data-terminal-key="arrowLeft" tabindex="-1" type="button">←</button>
        <button aria-label="Arrow up" class="terminal-key" data-terminal-key="arrowUp" tabindex="-1" type="button">↑</button>
        <button aria-label="Arrow down" class="terminal-key" data-terminal-key="arrowDown" tabindex="-1" type="button">↓</button>
        <button aria-label="Arrow right" class="terminal-key" data-terminal-key="arrowRight" tabindex="-1" type="button">→</button>
      </div>
    </div>
    <small aria-live="polite" class="terminal-key-error"></small>
  </div>`

const setTerminal = (page: Page): Promise<void> =>
  page.setContent(`
    <!doctype html>
    <html data-rly-root data-rly-theme="dark">
      <head><style>${fixtureCss}</style></head>
      <body class="connect-body">
        <div class="connect-shell">
          <div class="connect-workspace" data-mode="terminal">
            <div aria-hidden="true" class="connect-directory-screen" inert></div>
            <div aria-label="Agent terminal" class="connect-terminal-screen">
              <section class="terminal-stage">
                <div class="terminal-bar"><button class="terminal-back" type="button">Agents</button><div><strong>agent-01</strong><small>SER8 · codex</small></div><span class="fixture-state">connected</span></div>
                ${terminalRail}
                <div aria-label="Agent terminal" class="ghostty-terminal"><pre>echo hello</pre></div>
              </section>
            </div>
          </div>
        </div>
      </body>
    </html>`)

test("390x844 keeps directory chrome dense and the full list reachable without an inner clipped scroller", async ({ page }) => {
  await setEmbeddedDirectory(page)

  const intro = page.locator(".connect-embedded-intro")
  const filters = page.locator(".connect-filter-row")
  const agents = page.locator(".connect-agents")
  const header = page.locator(".fixture-standalone-header")
  const navigation = header.locator(".fleet-app-nav")
  const shell = page.locator(".connect-shell-embedded")
  const rows = page.locator(".connect-agent")

  await expect(page.locator("[data-agent-count]")).toBeVisible()
  expect((await header.boundingBox())?.height).toBeLessThanOrEqual(48)
  expect((await navigation.boundingBox())?.height).toBeLessThanOrEqual(32)
  expect((await intro.boundingBox())?.height).toBeLessThanOrEqual(64)
  expect((await filters.boundingBox())?.height).toBeLessThanOrEqual(38)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0)
  await expect
    .poll(() => agents.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBe(0)
  await expect
    .poll(() =>
      Promise.all([rows.last().boundingBox(), shell.boundingBox()]).then(([last, container]) =>
        last === null || container === null
          ? Number.POSITIVE_INFINITY
          : last.y + last.height - (container.y + container.height)
      )
    )
    .toBeLessThanOrEqual(0)

  await rows.last().scrollIntoViewIfNeeded()
  await expect(rows.last()).toBeInViewport()
})

test("mobile standalone keeps the directory as its bounded scroll owner", async ({ page }) => {
  await setStandaloneDirectory(page)

  const agents = page.locator(".connect-agents")
  const last = page.locator(".connect-agent").last()
  expect(await agents.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto")
  await expect.poll(() => agents.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBe(0)

  await last.scrollIntoViewIfNeeded()
  expect(await agents.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect(last).toBeInViewport()
})

test("desktop keeps its spacious hierarchy and scroll ownership", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 1280 })
  await setEmbeddedDirectory(page)

  await expect(page.locator(".connect-embedded-intro p")).toBeVisible()
  await expect(page.locator(".connect-search > span")).toBeVisible()
  expect(
    await page.locator(".connect-embedded-intro h1").evaluate((element) => getComputedStyle(element).fontSize)
  ).toBe("57.6px")
  expect(await page.locator(".connect-agent").first().evaluate((element) => getComputedStyle(element).paddingTop)).toBe(
    "12px"
  )
  expect(await page.locator(".connect-agents").evaluate((element) => getComputedStyle(element).overflowY)).toBe(
    "auto"
  )
})

test("390x844 keeps the terminal rail reachable with truthful button semantics", async ({ page }) => {
  await setTerminal(page)

  const rail = page.locator("[data-terminal-key-rail]")
  const ctrl = page.locator("[data-terminal-key=\"ctrl\"]")
  await expect(rail).toBeVisible()
  await expect(rail).toHaveAttribute("role", "toolbar")
  await expect(ctrl).toHaveAttribute("aria-pressed", "false")
  await expect(ctrl).toHaveAccessibleName("Ctrl")
  expect(await page.locator("[aria-keyshortcuts]").count()).toBe(0)
  await expect(page.locator("[data-terminal-key=\"tab\"]")).toBeEnabled()
  expect(await rail.locator(".terminal-key-scroll").evaluate((element) => getComputedStyle(element).overflowX)).toBe(
    "auto"
  )
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0)
  await ctrl.focus()
  expect(await ctrl.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid")
})

test("terminal toolbar arrow navigation skips disabled controls", async ({ page }) => {
  await setTerminal(page)
  const rail = page.locator("[data-terminal-key-rail]")
  await expect(rail.locator("button[tabindex=\"0\"]")).toHaveCount(1)
  await expect(rail.locator("button[tabindex=\"-1\"]")).toHaveCount(7)
  await page.addScriptTag({
    content: `${terminalRailNavigationSource}\nwindow.nextTerminalRailIndex = nextTerminalRailIndex`,
    type: "module"
  })
  const focusedKey = await page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>("[data-terminal-key-rail]")
    const helper = window.nextTerminalRailIndex
    if (rail === null || helper === undefined) throw new Error("terminal rail fixture missing")
    const buttons = [...rail.querySelectorAll<HTMLButtonElement>("button[data-terminal-key]")]
    const current = buttons.find((button) => button.dataset.terminalKey === "ctrl")
    const disabled = buttons.find((button) => button.dataset.terminalKey === "escape")
    if (current === undefined || disabled === undefined) throw new Error("terminal button fixture missing")
    disabled.disabled = true
    const nextIndex = helper(
      "ArrowRight",
      buttons.indexOf(current),
      buttons.map(({ disabled: isDisabled }) => !isDisabled)
    )
    if (nextIndex === null) throw new Error("terminal toolbar navigation unavailable")
    buttons[nextIndex]?.focus()
    return document.activeElement?.getAttribute("data-terminal-key")
  })
  expect(focusedKey).toBe("alt")
})

test("desktop terminal rail preserves the three-row stage and accessible key labels", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 1280 })
  await setTerminal(page)

  await expect(page.locator("[data-terminal-key=\"escape\"]")).toHaveAccessibleName("Escape")
  await expect(page.locator("[data-terminal-key=\"arrowUp\"]")).toHaveAccessibleName("Arrow up")
  expect(await page.locator("[aria-keyshortcuts]").count()).toBe(0)
  expect(
    await page.locator(".terminal-stage").evaluate((element) =>
      getComputedStyle(element).gridTemplateRows.split(" ").length
    )
  ).toBe(3)
  expect(await page.locator(".terminal-key").count()).toBe(8)
  await expect(page.locator(".terminal-key-error")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0)
})
