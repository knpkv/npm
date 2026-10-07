import { describe, expect, it } from "@effect/vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { NotificationPanel, type NotificationState } from "../src/approval-app-view.js"

const render = (state: NotificationState, failure?: string): string =>
  renderToStaticMarkup(
    <NotificationPanel
      canonicalUrl="https://ser8.example.test/"
      failure={failure}
      onDisable={() => undefined}
      onEnable={() => undefined}
      state={state}
    />
  )

describe("approval notification panel", () => {
  it("reduces configured notifications to a quiet status control", () => {
    const markup = render("enabled")
    expect(markup).toContain("notification-status")
    expect(markup).toContain("Notifications on")
    expect(markup).not.toContain("Approval notifications</h2>")
    expect(markup).not.toContain("iPhone Home Screen")
    expect(markup).not.toContain("Add to Home Screen")
  })

  it("avoids flashing setup instructions while checking configuration", () => {
    const markup = render("loading")
    expect(markup).toContain("notification-status")
    expect(markup).toContain("Checking notifications")
    expect(markup).not.toContain("Add to Home Screen")
  })

  it("keeps setup instructions collapsed when notifications are off", () => {
    const markup = render("disabled")
    expect(markup).toContain("Notifications off")
    expect(markup).toContain("Setup help")
    expect(markup).toContain("Add to Home Screen")
    expect(markup).toContain(">Enable<")
    expect(markup).not.toContain("section-title")
  })

  it("names the cause when checking notifications failed, and offers Enable again", () => {
    const markup = render("error", "the push service answered 410")
    expect(markup).toContain("Couldn&#x27;t check notifications: the push service answered 410.")
    expect(markup).toContain(">Enable<")
    expect(markup).not.toContain("Refresh and retry")
  })

  it("explains a blocked or unsupported browser instead of offering an Enable that can't work", () => {
    const inert: ReadonlyArray<NotificationState> = ["denied", "unsupported"]
    for (const state of inert) {
      expect(render(state)).not.toContain(">Enable<")
    }
    expect(render("denied")).toContain("blocked notifications for the hub")
    expect(render("unsupported")).toContain("add this page to the Home Screen first")
  })
})
