import { describe, expect, it } from "@effect/vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { NotificationPanel, type NotificationState } from "../src/approval-app-view.js"

const render = (state: NotificationState): string =>
  renderToStaticMarkup(
    <NotificationPanel
      canonicalUrl="https://ser8.example.test/"
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
})
