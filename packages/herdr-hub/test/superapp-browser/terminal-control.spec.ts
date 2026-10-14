import { FleetConnectAgentPage } from "@knpkv/herdr-connect/model"
import { expect, type Page, test, type WebSocketRoute } from "@playwright/test"
import { Schema } from "effect"

class TerminalControlFixtureError extends Schema.TaggedError<TerminalControlFixtureError>()(
  "TerminalControlFixtureError",
  { reason: Schema.Literals(["missing-socket", "missing-action-box"]) }
) {}

const reading = Schema.decodeUnknownSync(FleetConnectAgentPage)({
  agents: [{
    host: "atlas",
    id: "agent-terminal",
    name: "Worker",
    kind: "claude",
    state: "waiting",
    work: "The new pins are checked. Apply them on atlas?",
    lastActivityAt: 1_791_721_200_000
  }],
  failures: [],
  hosts: ["atlas"],
  nextCursor: null
})

const openTerminal = async (page: Page): Promise<void> => {
  // Forward the real constructor and observe open, without injecting a frame or inventing readiness.
  await page.addInitScript(() => {
    const Transport = window.WebSocket
    window.WebSocket = class extends Transport {
      constructor(url: string | URL, protocols?: string | Array<string>) {
        super(url, protocols)
        if (new URL(String(url), location.href).pathname !== "/v1/connect/session") return
        this.addEventListener("open", () => {
          const root = document.documentElement
          root.dataset.terminalSocketOpens = String(Number(root.dataset.terminalSocketOpens ?? "0") + 1)
        }, { once: true })
      }
    }
  })
  await page.route("**/v1/connect/agents", (route) => route.fulfill({ json: reading }))
  await page.goto("/#connect/overview")
  await expect(page.locator(".superapp-shell")).toBeVisible()
  await page.locator(".connect-home-agent").click()
  await page.getByRole("dialog").getByRole("button", { name: "Open terminal", exact: true }).click()
}

/** A real refused upgrade opens before its close frame; immediate route-handler closure skips open. */
const closeOpened = async (
  page: Page,
  sockets: ReadonlyArray<{ readonly socket: WebSocketRoute }>,
  index: number,
  opens: number,
  code: 4_423 | 4_424,
  reason: "agent already controlled" | "taken_over"
): Promise<void> => {
  await expect(page.locator("html")).toHaveAttribute("data-terminal-socket-opens", String(opens))
  const entry = sockets[index]
  if (entry === undefined) throw new TerminalControlFixtureError({ reason: "missing-socket" })
  await entry.socket.close({ code, reason })
}

const touchTarget = async (page: Page, action: "Take over" | "Reconnect"): Promise<void> => {
  const target = page.getByRole("button", { name: action, exact: true })
  const box = await target.boundingBox()
  expect(box).not.toBeNull()
  if (box === null) throw new TerminalControlFixtureError({ reason: "missing-action-box" })
  expect(box.width).toBeGreaterThanOrEqual(44)
  expect(box.height).toBeGreaterThanOrEqual(44)
  const owned = await target.evaluate((button) => {
    const box = button.getBoundingClientRect()
    return [-21.5, 0, 21.5].flatMap((x) =>
      [-21.5, 0, 21.5].map((y) => {
        const hit = document.elementFromPoint(box.x + box.width / 2 + x, box.y + box.height / 2 + y)
        return hit !== null && (hit === button || button.contains(hit))
      })
    )
  })
  expect(owned).toEqual(Array.from({ length: 9 }, () => true))
}

for (const theme of ["light", "dark"] satisfies ReadonlyArray<"light" | "dark">) {
  for (const state of ["controlled", "taken-over"] satisfies ReadonlyArray<"controlled" | "taken-over">) {
    /** Export 53: ownership is a neutral terminal panel, with an explicit accessible recovery action. */
    test(`terminal ${state} reference ${theme}`, async ({ page }, info) => {
      const width = page.viewportSize()?.width ?? 0
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      const sockets: Array<{ socket: WebSocketRoute }> = []
      await page.routeWebSocket("**/v1/connect/session?*", (socket) => {
        sockets.push({ socket })
      })
      await openTerminal(page)
      await page.locator("body").evaluate((body, scheme) => body.setAttribute("data-rly-theme", scheme), theme)
      await closeOpened(
        page,
        sockets,
        0,
        1,
        state === "controlled" ? 4_423 : 4_424,
        state === "controlled" ? "agent already controlled" : "taken_over"
      )
      const sheet = page.getByRole("dialog")
      const action = state === "controlled" ? "Take over" : "Reconnect"
      await expect(sheet.getByRole("heading", {
        name: state === "controlled" ? "Open on another device" : "Taken over on another device",
        exact: true
      })).toBeVisible()
      await expect(sheet.getByText(
        state === "controlled"
          ? "This terminal is in use on another device. Taking over disconnects it there."
          : "This terminal is now open somewhere else.",
        { exact: true }
      )).toBeVisible()
      await expect(sheet.getByRole("button", { name: action, exact: true })).toBeFocused()
      await expect(page.locator(".connect-terminal-screen")).toBeHidden()
      await expect(page.getByRole("alert")).toHaveCount(0)
      await touchTarget(page, action)
      await page.evaluate(() => document.fonts.ready)
      await sheet.screenshot({
        path: info.outputPath(`fidelity/connect-terminal-${state}-${String(width)}-${theme}.png`)
      })
      const measured = await sheet.locator(".connect-terminal-control").evaluate((panel) => {
        const style = getComputedStyle(panel)
        const box = panel.getBoundingClientRect()
        const button = panel.querySelector("button")?.getBoundingClientRect()
        const h3 = panel.querySelector("h3")?.getBoundingClientRect()
        return {
          height: box.height,
          radius: style.borderStartStartRadius,
          border: style.borderTopWidth,
          background: style.backgroundColor,
          surface: getComputedStyle(document.body).getPropertyValue("--rly-color-surface-3"),
          contentCentre: h3 === undefined || button === undefined ? null : (h3.top + button.bottom) / 2,
          panelCentre: box.y + box.height / 2
        }
      })
      expect(measured.height).toBeGreaterThanOrEqual(640)
      expect(measured.radius).toBe("20px")
      expect(measured.border).toBe("1px")
      expect(measured.contentCentre).toBeCloseTo(measured.panelCentre, 0)
      await page.keyboard.press("Tab")
      await page.keyboard.press("Shift+Tab")
      await expect(sheet.getByRole("button", { name: action, exact: true })).toBeFocused()
      const focus = await sheet.getByRole("button", { name: action, exact: true }).evaluate((button) => {
        const style = getComputedStyle(button)
        return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }
      })
      expect(focus.style).not.toBe("none")
      expect(focus.width).toBeGreaterThan(0)
      await page.emulateMedia({ forcedColors: "active" })
      await touchTarget(page, action)
      await page.keyboard.press("Escape")
      await expect(sheet).toHaveCount(0)
      await expect(page.locator(".connect-home-agent")).toBeFocused()
    })
  }
}

/** The fake transport owns two devices; server ordering and the ten-second release are covered at HTTP. */
test("two devices explicitly take over, reconnect ordinarily, and take over back", async ({ context, page }) => {
  const requests: Array<{ socket: WebSocketRoute; takeover: boolean }> = []
  let owner: WebSocketRoute | null = null
  await context.routeWebSocket("**/v1/connect/session?*", async (socket) => {
    const takeover = new URL(socket.url()).searchParams.get("takeover") === "1"
    requests.push({ socket, takeover })
    socket.onMessage(() => {})
    if (owner !== null && !takeover) {
      return
    }
    if (owner !== null) await owner.close({ code: 4_424, reason: "taken_over" })
    owner = socket
    socket.onClose(() => {
      if (owner === socket) owner = null
    })
    socket.send(JSON.stringify({ type: "terminal.ready" }))
  })
  const other = await context.newPage()
  try {
    await openTerminal(page)
    await expect(page.locator(".connect-terminal-screen")).toBeVisible()
    await openTerminal(other)
    await closeOpened(other, requests, 1, 1, 4_423, "agent already controlled")
    await expect(other.getByRole("button", { name: "Take over", exact: true })).toBeFocused()
    await other.getByRole("button", { name: "Take over", exact: true }).press("Enter")
    await expect(other.locator(".connect-terminal-screen")).toBeVisible()
    await expect(page.getByRole("heading", { name: "Taken over on another device", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeFocused()
    await page.getByRole("button", { name: "Reconnect", exact: true }).click()
    await closeOpened(page, requests, 3, 2, 4_423, "agent already controlled")
    await expect(page.getByRole("heading", { name: "Open on another device", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Take over", exact: true }).click()
    await expect(page.locator(".connect-terminal-screen")).toBeVisible()
    await expect(other.getByRole("button", { name: "Reconnect", exact: true })).toBeFocused()
    expect(requests.map(({ takeover }) => takeover)).toEqual([false, false, true, false, true])
  } finally {
    await other.close()
  }
})

test("pending takeover stays connecting and stage dismissal cancels its socket", async ({ page }) => {
  const sockets: Array<{ socket: WebSocketRoute }> = []
  const closed: Array<number | undefined> = []
  await page.routeWebSocket("**/v1/connect/session?*", (socket) => {
    sockets.push({ socket })
    if (sockets.length > 1) socket.onClose((code) => closed.push(code))
  })
  await openTerminal(page)
  await closeOpened(page, sockets, 0, 1, 4_423, "agent already controlled")
  await page.getByRole("button", { name: "Take over", exact: true }).click()
  await expect.poll(() => sockets.length).toBe(2)
  await expect(page.getByRole("dialog").getByText("Connecting to Worker…", { exact: true })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Take over", exact: true })).toHaveCount(0)
  await page.getByRole("dialog").getByRole("button", {
    name: page.viewportSize()?.width === 390 ? "Back to Connect" : "Close",
    exact: true
  }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect.poll(() => closed.length).toBe(1)
  await expect(page.locator(".connect-home-agent")).toBeFocused()
})
