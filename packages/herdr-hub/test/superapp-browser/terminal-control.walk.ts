/** Seven acceptance flows on two independent devices using the real hub socket path. */
import { FleetConnectAgentPage } from "@knpkv/herdr-connect/model"
import { expect, type Locator, type Page } from "@playwright/test"
import { Schema } from "effect"
import { test } from "./terminal-walk-server.js"

class TerminalWalkActionError extends Schema.TaggedError<TerminalWalkActionError>()("TerminalWalkActionError", {
  action: Schema.String
}) {}

/** Reach controls through the keyboard's real tab order, rather than assigning DOM focus. */
const tabTo = async (page: Page, target: Locator): Promise<void> => {
  const destination = await target.evaluate((element) =>
    element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName
  )
  const order: Array<{ tag: string; id: string; label: string; insideDialog: boolean }> = []
  const record = () =>
    test.info().attach("tab-order", {
      body: JSON.stringify({ page: page.url(), target: destination, order }, null, 2),
      contentType: "application/json"
    })
  for (let attempt = 0; attempt <= 24; attempt++) {
    order.push(
      await page.evaluate(() => {
        const element = document.activeElement
        return {
          tag: element?.tagName ?? "none",
          id: element?.id ?? "",
          label: element?.getAttribute("aria-label") ?? element?.textContent?.trim().slice(0, 160) ?? "",
          insideDialog: element !== null && element.closest("[role=\"dialog\"]") !== null
        }
      })
    )
    if (await target.evaluate((element) => element === document.activeElement)) {
      await record()
      return
    }
    if (attempt < 24) await page.keyboard.press("Tab")
  }
  await record()
  throw new TerminalWalkActionError({ action: `${destination}: target missing from tab order` })
}

const connected = async (page: Page): Promise<void> => {
  await expect(page.locator(".connect-terminal-screen")).toBeVisible()
  await expect(page.locator(".connect-terminal-screen .terminal-bar").getByText("connected", { exact: true }))
    .toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
}

const recovery = async (page: Page, state: "controlled" | "taken-over"): Promise<void> => {
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", {
    name: state === "controlled" ? "Open on another device" : "Taken over on another device",
    exact: true
  })).toBeVisible()
  await expect(dialog.getByRole("button", {
    name: state === "controlled" ? "Take over" : "Reconnect",
    exact: true
  })).toBeFocused()
  await expect(page.locator(".connect-terminal-screen")).toBeHidden()
  await expect(page.getByRole("alert")).toHaveCount(0)
}

const touchAction = async (page: Page, name: string): Promise<void> => {
  const action = page.getByRole("dialog").getByRole("button", { name, exact: true })
  const box = await action.boundingBox()
  if (box === null) throw new TerminalWalkActionError({ action: `${name} has no hit area` })
  expect(box.width).toBeGreaterThanOrEqual(44)
  expect(box.height).toBeGreaterThanOrEqual(44)
  await action.tap()
}

const keyboardAction = async (page: Page, name: string): Promise<void> => {
  const action = page.getByRole("dialog").getByRole("button", { name, exact: true })
  await tabTo(page, action)
  await expect(action).toBeFocused()
  await page.keyboard.press("Enter")
}

const openTerminal = async (page: Page, keyboard: boolean): Promise<void> => {
  const row = page.locator(".connect-home-agent")
  await expect(row).toHaveCount(1)
  if (keyboard) {
    await tabTo(page, row)
    await page.keyboard.press("Enter")
    await keyboardAction(page, "Open terminal")
  } else {
    await row.tap()
    await touchAction(page, "Open terminal")
  }
}

/** Capture actual focus, selected identity, and visible connection state on each page at every step. */
const pageState = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement
    const dialog = document.querySelector("[role=\"dialog\"]")
    return {
      active: active === null ? null : {
        tag: active.tagName,
        id: active.id,
        className: active.getAttribute("class"),
        role: active.getAttribute("role"),
        label: active.getAttribute("aria-label"),
        text: active.textContent?.trim().slice(0, 160) ?? "",
        insideDialog: dialog?.contains(active) ?? false,
        focusVisible: active.matches(":focus-visible"),
        outlineStyle: getComputedStyle(active).outlineStyle,
        outlineWidth: getComputedStyle(active).outlineWidth
      },
      dialog: dialog?.textContent?.trim() ?? null,
      terminalVisible: [...document.querySelectorAll(".connect-terminal-screen")].some((element) =>
        element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible" &&
        element.closest("[inert], [aria-hidden=\"true\"]") === null
      ),
      alerts: [...document.querySelectorAll("[role=\"alert\"]")].map((element) => element.textContent),
      url: location.href
    }
  })

test("terminal takeover acceptance walk", async ({ browser, hub }, info) => {
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 900 },
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
    reducedMotion: "reduce",
    colorScheme: "light"
  })
  try {
    const desktopContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ignoreHTTPSErrors: true,
      reducedMotion: "reduce",
      colorScheme: "light"
    })
    try {
      const phone = await phoneContext.newPage()
      const desktop = await desktopContext.newPage()
      const steps: Array<
        {
          step: string
          rows: ReadonlyArray<number>
          phone: Awaited<ReturnType<typeof pageState>>
          desktop: Awaited<ReturnType<typeof pageState>>
        }
      > = []
      const capture = async (step: string, rows: ReadonlyArray<number>): Promise<void> => {
        const state = {
          step,
          rows,
          phone: await pageState(phone),
          desktop: await pageState(desktop),
          server: await hub.snapshot()
        }
        steps.push(state)
        // Save the log before the shots too, so an interrupted walk retains its last observed focus.
        await hub.writeArtifact("walk.json", JSON.stringify({ steps }, null, 2))
        await hub.writeArtifact(`${step}-focus.json`, JSON.stringify(state, null, 2))
        await phone.screenshot({ path: info.outputPath(`${step}-phone-390.png`) })
        await desktop.screenshot({ path: info.outputPath(`${step}-desktop-1280.png`) })
      }
      for (const page of [phone, desktop]) {
        await page.goto(`${hub.origin}/#connect/overview`)
        await expect(page.locator(".superapp-shell")).toBeVisible()
        await expect(page.locator(".connect-home-agent")).toHaveCount(1)
        await page.locator("body").evaluate((body) => body.setAttribute("data-rly-theme", "light"))
        await page.evaluate(() => document.fonts.ready)
      }
      await capture("01-directory", [])
      await openTerminal(phone, false)
      await connected(phone)
      await capture("02-phone-connected", [1])
      await openTerminal(desktop, true)
      await recovery(desktop, "controlled")
      await capture("03-desktop-refused", [1, 7])

      // A real five-second inventory poll replaces the agent object without moving keyboard focus.
      const close = desktop.getByRole("dialog").getByRole("button", { name: "Close", exact: true })
      await tabTo(desktop, close)
      const refresh = desktop.waitForResponse(async (response) => {
        if (new URL(response.url()).pathname !== "/v1/connect/agents" || !response.ok()) return false
        const page = Schema.decodeUnknownSync(FleetConnectAgentPage)(await response.json())
        return page.agents.some((agent) => agent.work === "Inventory reading 2")
      })
      await hub.refreshInventory()
      await refresh
      await expect(close).toBeFocused()
      await capture("04-close-focus-after-poll", [5])
      await keyboardAction(desktop, "Take over")
      await connected(desktop)
      await recovery(phone, "taken-over")
      await capture("05-desktop-takeover", [1, 2, 5])
      await touchAction(phone, "Reconnect")
      await recovery(phone, "controlled")
      await capture("06-phone-reconnect-refused", [3, 7])
      await touchAction(phone, "Take over")
      await connected(phone)
      await recovery(desktop, "taken-over")
      await capture("07-phone-takeover-back", [4])

      // Each cancellation runs against an old connector whose real scope finalizer is held.
      for (const dismissal of ["Close", "Escape"] satisfies ReadonlyArray<"Close" | "Escape">) {
        await keyboardAction(desktop, "Reconnect")
        await recovery(desktop, "controlled")
        const before = await hub.snapshot()
        await hub.holdCleanup()
        try {
          await keyboardAction(desktop, "Take over")
          await expect.poll(async () => (await hub.snapshot()).holding).toBe(true)
          await expect(desktop.getByRole("dialog").getByText("Connecting to Worker…", { exact: true })).toBeVisible()
          await expect(desktop.getByRole("alert")).toHaveCount(0)
          await expect(desktop.getByRole("button", { name: "Take over", exact: true })).toHaveCount(0)
          expect((await hub.snapshot()).opened).toBe(before.opened)
          await recovery(phone, "taken-over")
          await capture(`08-pending-${dismissal.toLowerCase()}`, [6])
          await expect(desktop.getByRole("dialog").getByText("Connecting to Worker…", { exact: true })).toBeVisible()
          if (dismissal === "Escape") await desktop.keyboard.press("Escape")
          else await keyboardAction(desktop, "Close")
          await expect(desktop.getByRole("dialog")).toHaveCount(0)
          await expect(desktop.locator(".connect-home-agent")).toBeFocused()
          await capture(`09-cancelled-${dismissal.toLowerCase()}`, [5, 6])
        } finally {
          await hub.releaseCleanup()
        }
        await expect.poll(async () => (await hub.snapshot()).released).toBe(before.released + 1)
        await touchAction(phone, "Reconnect")
        await connected(phone)
        expect((await hub.snapshot()).opened).toBe(before.opened + 1)
        // Close leaves the directory open; reopen normally to obtain the real controlled panel.
        await openTerminal(desktop, true)
        await recovery(desktop, "controlled")
        await keyboardAction(desktop, "Take over")
        await connected(desktop)
        await recovery(phone, "taken-over")
        await capture(`10-recovered-after-${dismissal.toLowerCase()}`, [6, 7])
        if (dismissal === "Close") {
          await touchAction(phone, "Reconnect")
          await recovery(phone, "controlled")
          await touchAction(phone, "Take over")
          await connected(phone)
          await recovery(desktop, "taken-over")
        }
      }

      await touchAction(phone, "Reconnect")
      await recovery(phone, "controlled")
      const beforeBack = await hub.snapshot()
      await hub.holdCleanup()
      try {
        await touchAction(phone, "Take over")
        await expect.poll(async () => (await hub.snapshot()).holding).toBe(true)
        await expect(phone.getByRole("dialog").getByText("Connecting to Worker…", { exact: true })).toBeVisible()
        await expect(phone.getByRole("alert")).toHaveCount(0)
        expect((await hub.snapshot()).opened).toBe(beforeBack.opened)
        await recovery(desktop, "taken-over")
        await capture("11-phone-pending-back", [6])
        await expect(phone.getByRole("dialog").getByText("Connecting to Worker…", { exact: true })).toBeVisible()
        await touchAction(phone, "Back to Connect")
        await expect(phone.getByRole("dialog")).toHaveCount(0)
        await expect(phone.locator(".connect-home-agent")).toBeFocused()
        await capture("12-phone-cancelled-back", [6])
      } finally {
        await hub.releaseCleanup()
      }
      await expect.poll(async () => (await hub.snapshot()).released).toBe(beforeBack.released + 1)
      await keyboardAction(desktop, "Reconnect")
      await connected(desktop)
      expect((await hub.snapshot()).opened).toBe(beforeBack.opened + 1)
      await capture("13-desktop-reconnected-after-back", [6])

      // The inventory deliberately retains the absent agent, as a stale real directory can.
      const exitKeys: Array<{ key: string; state: Awaited<ReturnType<typeof pageState>> }> = []
      for (const key of ["Tab", "Shift+Tab", "Escape", "Control+k"]) {
        await desktop.keyboard.press(key)
        const state = await pageState(desktop)
        exitKeys.push({ key, state })
        if (state.active?.id !== "connect-terminal-input") break
      }
      const exit = exitKeys.find(({ state }) => state.active?.id !== "connect-terminal-input")
      const friction = {
        flow: "Leave a connected terminal using the keyboard",
        result: exit === undefined
          ? "No application exit shortcut found. Tab, Shift+Tab, Escape and Ctrl+K retain terminal input focus. Ghostty handles terminal keys before the shell's defaultPrevented guard; there is no dedicated application escape binding."
          : `${exit.key} leaves terminal input; inspect the captured focus to see its destination.`,
        observations: exitKeys,
        scope: "Existing behavior; separate accessibility follow-up, not a terminal takeover blocker.",
        setup: "The detached-agent case reloads the desktop to release its socket without claiming a keyboard exit."
      }
      await hub.writeArtifact("keyboard-exit-friction.json", JSON.stringify(friction, null, 2))
      await capture("13a-keyboard-exit-probes", [5])
      // Fixture reset, not a keyboard exit: reload releases this device's real WebSocket.
      await desktop.reload()
      await expect(desktop.locator(".connect-home-agent")).toHaveCount(1)
      await desktop.locator("body").evaluate((body) => body.setAttribute("data-rly-theme", "light"))
      await expect(desktop.locator(".connect-terminal-screen")).toBeHidden()
      await capture("13b-desktop-reloaded-directory", [7])
      await expect.poll(async () => (await hub.snapshot()).released).toBe(beforeBack.released + 2)
      await hub.detach()
      await openTerminal(phone, false)
      await expect(phone.getByRole("alert")).toContainText("TerminalAgentNotFoundError")
      await expect(phone.getByRole("heading", { name: "Open on another device", exact: true })).toHaveCount(0)
      await expect(phone.getByRole("heading", { name: "Taken over on another device", exact: true })).toHaveCount(0)
      await expect(phone.locator(".connect-terminal-screen")).toBeHidden()
      await capture("14-detached-agent-failure", [7])
      await hub.writeArtifact(
        "acceptance.json",
        JSON.stringify(
          {
            rows: [
              {
                row: 1,
                flow: "Phone opens terminal, desktop takes over",
                steps: ["02-phone-connected", "05-desktop-takeover"]
              },
              {
                row: 2,
                flow: "Phone sees Taken over on another device with Reconnect",
                steps: ["05-desktop-takeover"]
              },
              {
                row: 3,
                flow: "Phone Reconnect receives Open on another device",
                steps: ["06-phone-reconnect-refused"]
              },
              { row: 4, flow: "Phone Take over back disconnects desktop", steps: ["07-phone-takeover-back"] },
              {
                row: 5,
                flow: "Keyboard action and focus stay in the selected stage",
                steps: ["04-close-focus-after-poll", "05-desktop-takeover", "09-cancelled-close", "09-cancelled-escape"]
              },
              {
                row: 6,
                flow: "Pending admission retains Connecting; Close/Back/Escape cancel it",
                steps: [
                  "08-pending-close",
                  "08-pending-escape",
                  "11-phone-pending-back",
                  "13-desktop-reconnected-after-back"
                ]
              },
              {
                row: 7,
                flow: "Ordinary refusal and detached-agent failure remain unchanged",
                steps: ["03-desktop-refused", "06-phone-reconnect-refused", "14-detached-agent-failure"]
              }
            ],
            assertions: "completed",
            visualReview: "pending",
            friction: [friction]
          },
          null,
          2
        )
      )
    } finally {
      await desktopContext.close()
    }
  } finally {
    await phoneContext.close()
  }
})
