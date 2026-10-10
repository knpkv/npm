import { expect, test } from "@playwright/test"
import { Schema } from "effect"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { TerminalClientCommand } from "../../src/model.js"
import type { TerminalModifiers } from "../../src/terminal-keyboard.js"
import type { TerminalInputHandlerOptions } from "../../src/terminal-output.js"

type GhosttyTerminal = {
  readonly onData: (handler: (value: string) => void) => { readonly dispose: () => void }
  readonly open: (element: HTMLElement) => void
  readonly input: (value: string, wasUserInput?: boolean) => void
  readonly write: (value: string | Uint8Array) => void
  readonly dispose: () => void
}

type GhosttyWeb = {
  readonly init: () => Promise<void>
  readonly Terminal: new(options: {
    readonly cols: number
    readonly rows: number
  }) => GhosttyTerminal
}

type TerminalOutputBoundary = {
  readonly isActive: () => boolean
  readonly run: (write: () => void) => void
}

type TerminalOutputWriter = {
  readonly write: (data: Uint8Array) => void
}

declare global {
  interface Window {
    readonly GhosttyWeb: GhosttyWeb
    makeTerminalInputHandler?: (
      options: TerminalInputHandlerOptions
    ) => (text: string) => void
    terminalOutputBoundary?: TerminalOutputBoundary
    writeTerminalOutput?: (
      terminal: TerminalOutputWriter,
      data: Uint8Array,
      outputBoundary: TerminalOutputBoundary
    ) => void
  }
}

const packageRoot = resolve(new URL("../..", import.meta.url).pathname)
const ghosttyScript = resolve(
  new URL("../../../..", import.meta.url).pathname,
  "node_modules/.pnpm/ghostty-web@0.4.0/node_modules/ghostty-web/dist/ghostty-web.umd.cjs"
)
const terminalOutputSource = transpileModule(
  readFileSync(resolve(packageRoot, "src/terminal-output.ts"), "utf8"),
  {
    compilerOptions: {
      module: ModuleKind.ESNext,
      target: ScriptTarget.ES2022
    }
  }
).outputText

const ReceivedCommands = Schema.Array(Schema.Struct({ at: Schema.Number, command: TerminalClientCommand }))

for (const width of [390, 320]) {
  test(`phone terminal keys fit two rows with 44px targets at ${width}px`, async ({ page, request }) => {
    await request.post("/__test/reset")
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/")
    await page.locator(".connect-agent", { hasText: "fixture-pane" }).click()
    await page.getByRole("button", { name: "Open terminal" }).click()
    await expect(page.getByText("connected", { exact: true })).toBeVisible()
    const rail = page.getByRole("toolbar", { name: "Terminal keyboard controls" })
    const keys = rail.locator(".terminal-key-group:not(.terminal-key-group-pinned) button")
    await expect(keys).toHaveCount(9)
    const rowTops = await keys.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top))
    const rows = [...new Set(rowTops)]
    expect(rows).toHaveLength(2)
    expect(rows.map((top) => rowTops.filter((rowTop) => rowTop === top).length)).toEqual([5, 4])
    const targets = await rail.getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const { height, width } = button.getBoundingClientRect()
        return { height, label: button.textContent, width }
      })
    )
    for (const target of targets) {
      expect(target.width, `${target.label} width`).toBeGreaterThanOrEqual(44)
      expect(target.height, `${target.label} height`).toBeGreaterThanOrEqual(44)
    }
    await rail.screenshot({
      path: resolve(packageRoot, `test-results/fidelity/key-rail-${width}-two-rows.png`)
    })
  })
}

for (const width of [390, 1280]) {
  for (const theme of ["light", "dark"] satisfies ReadonlyArray<"light" | "dark">) {
    test(`Shift then Tab sends back-tab once at ${width}px in ${theme}`, async ({ page, request }) => {
      await request.post("/__test/reset")
      await page.setViewportSize({ width, height: 844 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto("/")
      await page.evaluate((theme) => {
        document.body.dataset.rlyTheme = theme
        document.documentElement.dataset.rlyTheme = theme
      }, theme)
      await page.locator(".connect-agent", { hasText: "fixture-pane" }).click()
      await page.getByRole("button", { name: "Open terminal" }).click()
      await expect(page.getByText("connected", { exact: true })).toBeVisible()
      const rail = page.getByRole("toolbar", { name: "Terminal keyboard controls" })
      const shift = rail.getByRole("button", { name: "Shift", exact: true })
      await expect(shift).toHaveAttribute("aria-pressed", "false")
      await rail.screenshot({
        path: resolve(packageRoot, `test-results/fidelity/key-rail-${width}-${theme}-plain.png`)
      })
      await shift.click()
      await expect(shift).toHaveAttribute("aria-pressed", "true")
      await rail.screenshot({
        path: resolve(packageRoot, `test-results/fidelity/key-rail-${width}-${theme}-shift.png`)
      })
      await rail.getByRole("button", { name: "Shift Tab", exact: true }).click()
      await expect(shift).toHaveAttribute("aria-pressed", "false")
      await rail.getByRole("button", { name: "Tab", exact: true }).click()
      const inputTexts = async () => {
        const response = await request.get("/__test/commands")
        const commands = Schema.decodeUnknownSync(ReceivedCommands)(await response.json())
        return commands.flatMap(({ command }) => command.type === "terminal.input" ? [command.text] : [])
      }
      await expect.poll(inputTexts).toEqual(["\u001b[Z", "\t"])
      for (const base of ["Ctrl", "Alt"]) {
        await rail.getByRole("button", { name: base, exact: true }).click()
        await shift.click()
        await expect(shift).toHaveAttribute("aria-pressed", "true")
        await rail.screenshot({
          path: resolve(packageRoot, `test-results/fidelity/key-rail-${width}-${theme}-${base.toLowerCase()}-shift.png`)
        })
        await shift.click()
      }
    })
  }
}

test("Ghostty protocol replies stay unchanged while Ctrl is latched", async ({ page }) => {
  await page.setContent("<div id=\"terminal\" style=\"block-size: 240px; inline-size: 640px\"></div>")
  await page.addScriptTag({ path: ghosttyScript })
  await page.addScriptTag({
    content:
      `${terminalOutputSource}\nwindow.terminalOutputBoundary = makeTerminalOutputBoundary()\nwindow.makeTerminalInputHandler = makeTerminalInputHandler\nwindow.writeTerminalOutput = writeTerminalOutput`,
    type: "module"
  })

  const result = await page.evaluate(async () => {
    await window.GhosttyWeb.init()
    const container = document.querySelector<HTMLElement>("#terminal")
    if (container === null) throw new Error("terminal fixture missing")
    const terminal = new window.GhosttyWeb.Terminal({ cols: 40, rows: 10 })
    terminal.open(container)
    const sent: Array<string> = []
    const failures: Array<string> = []
    let modifier: TerminalModifiers = { base: "ctrl", shift: false }
    const outputBoundary = window.terminalOutputBoundary
    if (outputBoundary === undefined) throw new Error("terminal output boundary missing")
    const makeTerminalInputHandler = window.makeTerminalInputHandler
    if (makeTerminalInputHandler === undefined) throw new Error("terminal input handler missing")
    const writeTerminalOutput = window.writeTerminalOutput
    if (writeTerminalOutput === undefined) throw new Error("terminal output writer missing")
    const pendingInput = {
      clear: () => undefined,
      drain: () => "",
      push: (): "queued" => "queued"
    }
    const input = makeTerminalInputHandler({
      applyInput: (value) => {
        if (modifier.base === "ctrl" && value === "c") {
          return { _tag: "supported", text: "\u0003", nextModifier: { base: null, shift: false } }
        }
        if (modifier.base === "ctrl") return null
        return { _tag: "supported", text: value, nextModifier: { base: null, shift: false } }
      },
      isReady: () => true,
      onFailure: (failure) => failures.push(failure),
      outputBoundary,
      pendingInput,
      sendInput: (value) => {
        sent.push(value)
        return true
      },
      setModifier: (next) => {
        modifier = next
      }
    })
    const subscription = terminal.onData(input)

    writeTerminalOutput(terminal, new TextEncoder().encode("\u001b[6n"), outputBoundary)
    await new Promise((resolve) => setTimeout(resolve, 100))
    terminal.input("c", true)
    subscription.dispose()
    terminal.dispose()
    return { failures, modifier, sent }
  })

  expect(result).toEqual({ failures: [], modifier: { base: null, shift: false }, sent: ["\u001b[1;1R", "\u0003"] })
})
