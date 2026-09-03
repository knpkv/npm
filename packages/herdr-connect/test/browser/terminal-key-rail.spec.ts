import { expect, test } from "@playwright/test"
import { resolve } from "node:path"

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

declare global {
  interface Window {
    readonly GhosttyWeb: GhosttyWeb
  }
}

const ghosttyScript = resolve(
  new URL("../../../..", import.meta.url).pathname,
  "node_modules/.pnpm/ghostty-web@0.4.0/node_modules/ghostty-web/dist/ghostty-web.umd.cjs"
)

test("Ghostty protocol replies stay unchanged while Ctrl is latched", async ({ page }) => {
  await page.setContent("<div id=\"terminal\" style=\"block-size: 240px; inline-size: 640px\"></div>")
  await page.addScriptTag({ path: ghosttyScript })

  const result = await page.evaluate(async () => {
    await window.GhosttyWeb.init()
    const container = document.querySelector<HTMLElement>("#terminal")
    if (container === null) throw new Error("terminal fixture missing")
    const terminal = new window.GhosttyWeb.Terminal({ cols: 40, rows: 10 })
    terminal.open(container)
    const sent: Array<string> = []
    let modifier: "ctrl" | null = "ctrl"
    let processingTerminalOutput = false
    const subscription = terminal.onData((value) => {
      if (processingTerminalOutput) {
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

    processingTerminalOutput = true
    terminal.write("\u001b[6n")
    await new Promise((resolve) => setTimeout(resolve, 100))
    processingTerminalOutput = false
    terminal.input("c", true)
    subscription.dispose()
    terminal.dispose()
    return { modifier, sent }
  })

  expect(result).toEqual({ modifier: null, sent: ["\u001b[1;1R", "\u0003"] })
})
