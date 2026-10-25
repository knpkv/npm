import { describe, expect, it } from "@effect/vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { HubSessionView } from "../src/hub-session-client.js"
import { latestOnly, SessionControl, SessionDetails, TailscaleLoginCard } from "../src/hub-session-view.js"

const until = Date.UTC(2026, 9, 25, 21, 5)
const csrf = "b".repeat(64)
const signedIn: HubSessionView = {
  signedIn: true,
  kind: "tailscale",
  login: "owner@example.test",
  device: "owner-laptop",
  expiresAt: until,
  csrf
}
const signedOut: HubSessionView = {
  signedIn: false,
  kind: "tailscale",
  login: "owner@example.test",
  device: "owner-laptop"
}

const control = (view: HubSessionView, open = false) =>
  renderToStaticMarkup(
    <SessionControl
      view={view}
      open={open}
      onToggle={() => undefined}
      onClose={() => undefined}
      onLogOut={() => undefined}
      timeZone="UTC"
    />
  )

describe("session control", () => {
  // Page 22 state 2: who, and until when, with the popover behind the control.
  it("names a logged-in Tailscale person and when the session ends, as a control that opens the popover", () => {
    const markup = control(signedIn)
    expect(markup).toContain(">Owner<")
    expect(markup).toContain("Logged in until 21:05")
    expect(markup).toContain(
      'aria-label="Your Tailscale session, owner@example.test on owner-laptop, logged in until 21:05"'
    )
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).not.toContain('Your session"')
  })

  // Only what is true before passkeys and enforcement: who, how, until when, and Log out. The design's
  // "You can" list (passkeys each time) waits for the PRs that make it true.
  it("opens a popover with who, how, until when and Log out, and nothing about passkeys", () => {
    const markup = control(signedIn, true)
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toMatch(/aria-controls="([^"]+)"[\s\S]*id="\1"/u)
    expect(markup).toContain('role="dialog" aria-label="Your session"')
    expect(markup).toContain(">owner@example.test<")
    expect(markup).toContain("Logged in with Tailscale on owner-laptop")
    expect(markup).toContain("Until 21:05")
    expect(markup).toContain(">Log out<")
    expect(markup).not.toContain("passkey")
    expect(markup).not.toContain("You can")
  })

  // Not logged in, it says so, and claims nothing about what that allows until enforcement makes it true.
  it("says a Tailscale person isn't logged in, without claiming view only", () => {
    const markup = control(signedOut)
    expect(markup).toContain("Not logged in")
    expect(markup).not.toContain("view only")
    expect(markup).toContain('aria-label="Your Tailscale session on owner-laptop, not logged in"')
    expect(markup).not.toContain("aria-expanded")
  })

  // The local user logged in through `herdr-hub login` is this computer.
  it("names a local session as this computer, with when it ends", () => {
    const markup = control({ signedIn: true, kind: "local", expiresAt: until, csrf }, true)
    expect(markup).toContain(">This computer<")
    expect(markup).toContain("Logged in until 21:05")
    expect(markup).toContain("Until 21:05")
    expect(markup).toContain(">Log out<")
    expect(markup).not.toContain("Tailscale")
  })
})

describe("session details", () => {
  // The popover's content, on its own.
  it("shows who, how, until when and Log out for a logged-in session, and nothing otherwise", () => {
    const markup = renderToStaticMarkup(<SessionDetails view={signedIn} onLogOut={() => undefined} timeZone="UTC" />)
    expect(markup).toContain(">owner@example.test<")
    expect(markup).toContain("Logged in with Tailscale on owner-laptop")
    expect(markup).toContain("Until 21:05")
    expect(markup).toContain(">Log out<")
    expect(renderToStaticMarkup(<SessionDetails view={signedOut} onLogOut={() => undefined} />)).toBe("")
  })
})

describe("Tailscale login card", () => {
  // Page 22 states 1 and 3, without the lines that describe enforcement ("View only until you log in." and
  // the fleet host's agents line), which ship with it.
  it("offers to continue as the WhoIs login on this device", () => {
    const markup = renderToStaticMarkup(<TailscaleLoginCard view={signedOut} busy={false} onLogIn={() => undefined} />)
    expect(markup).toContain("Not logged in")
    expect(markup).toContain("Continue as owner@example.test?")
    expect(markup).toContain("Tailscale says this is owner-laptop. Logging in keeps you signed in here for 8 hours.")
    expect(markup).toContain(">Log in with Tailscale<")
    expect(markup).not.toContain("View only")
    expect(markup).not.toContain("runs agents")
    // A plain section: a live region would be read out again on every minute's session read.
    expect(markup).not.toContain('role="status"')
  })

  it("leaves out the device sentence when Tailscale names no device, and disables the button while logging in", () => {
    const { device: _device, ...nameless } = signedOut
    const markup = renderToStaticMarkup(<TailscaleLoginCard view={nameless} busy onLogIn={() => undefined} />)
    expect(markup).not.toContain("Tailscale says")
    expect(markup).toContain("Logging in keeps you signed in here for 8 hours.")
    expect(markup).toMatch(/<button[^>]*disabled/)
  })

  it("draws nothing for a logged-in person or the local user", () => {
    expect(renderToStaticMarkup(<TailscaleLoginCard view={signedIn} busy={false} onLogIn={() => undefined} />)).toBe("")
    expect(
      renderToStaticMarkup(
        <TailscaleLoginCard view={{ signedIn: false, kind: "local" }} busy={false} onLogIn={() => undefined} />
      )
    ).toBe("")
  })
})

describe("latest read wins", () => {
  // A minute's read can overlap the read after a log-in or log-out; the older one must not land last.
  it("applies only the result of the latest read started", () => {
    const latest = latestOnly()
    const first = latest.begin()
    const second = latest.begin()
    expect(second()).toBe(true)
    expect(first()).toBe(false)
    const third = latest.begin()
    expect(second()).toBe(false)
    expect(third()).toBe(true)
  })
})
