import { expect, test } from "@playwright/test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"

type GhosttyTerminal = {
  readonly onData: (handler: (value: string) => void) => { readonly dispose: () => void }
  readonly open: (element: HTMLElement) => void
  readonly input: (value: string, wasUserInput?: boolean) => void
  readonly write: (value: string) => void
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

declare global {
  interface Window {
    readonly GhosttyWeb: GhosttyWeb
    terminalOutputBoundary?: TerminalOutputBoundary
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

test("Ghostty protocol replies stay unchanged while Ctrl is latched", async ({ page }) => {
  await page.setContent("<div id=\"terminal\" style=\"block-size: 240px; inline-size: 640px\"></div>")
  await page.addScriptTag({ path: ghosttyScript })
  await page.addScriptTag({
    content: `${terminalOutputSource}\nwindow.terminalOutputBoundary = makeTerminalOutputBoundary()`,
    type: "module"
  })

  const result = await page.evaluate(async () => {
    await window.GhosttyWeb.init()
    const container = document.querySelector<HTMLElement>("#terminal")
    if (container === null) throw new Error("terminal fixture missing")
    const terminal = new window.GhosttyWeb.Terminal({ cols: 40, rows: 10 })
    terminal.open(container)
    const sent: Array<string> = []
    let modifier: "ctrl" | null = "ctrl"
    const outputBoundary = window.terminalOutputBoundary
    if (outputBoundary === undefined) throw new Error("terminal output boundary missing")
    const subscription = terminal.onData((value) => {
      if (outputBoundary.isActive()) {
        sent.push(value)
        return
      }
      if (modifier === "ctrl" && value === "c") {
        sent.push("\u0003")
        modifier = null
        return
      }
      sent.push(value)
    })

    outputBoundary.run(() => terminal.write("\u001b[6n"))
    await new Promise((resolve) => setTimeout(resolve, 100))
    terminal.input("c", true)
    subscription.dispose()
    terminal.dispose()
    return { modifier, sent }
  })

  expect(result).toEqual({ modifier: null, sent: ["\u001b[1;1R", "\u0003"] })
})
