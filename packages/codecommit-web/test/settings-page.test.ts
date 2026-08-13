// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import { act, type AnchorHTMLAttributes, createElement } from "react"
import { createRoot } from "react-dom/client"

import { SettingsPage } from "../src/client/components/settings-page.js"

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: { tab: "about" }
}))

vi.mock("react-router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) =>
    createElement("a", { ...props, href: to }, children),
  useNavigate: () => routerMocks.navigate,
  useParams: () => routerMocks.params
}))

vi.mock("../src/client/components/settings-about.js", () => ({
  SettingsAbout: () => createElement("p", null, "About content")
}))
vi.mock("../src/client/components/settings-accounts.js", () => ({ SettingsAccounts: () => null }))
vi.mock("../src/client/components/settings-audit.js", () => ({ SettingsAudit: () => null }))
vi.mock("../src/client/components/settings-config.js", () => ({ SettingsConfig: () => null }))
vi.mock("../src/client/components/settings-notifications.js", () => ({ SettingsNotifications: () => null }))
vi.mock("../src/client/components/settings-permissions.js", () => ({ SettingsPermissions: () => null }))
vi.mock("../src/client/components/settings-refresh.js", () => ({ SettingsRefresh: () => null }))
vi.mock("../src/client/components/settings-sandbox.js", () => ({ SettingsSandbox: () => null }))
vi.mock("../src/client/components/settings-theme.js", () => ({ SettingsTheme: () => null }))

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

describe("SettingsPage", () => {
  it("models URL-backed settings destinations as navigation links", async () => {
    const host = document.createElement("div")
    const root = createRoot(host)
    await act(async () => root.render(createElement(SettingsPage)))

    const links = Array.from(host.querySelectorAll<HTMLAnchorElement>("nav[aria-label=\"Settings\"] a"))
    expect(links).toHaveLength(9)
    expect(links.find((link) => link.textContent?.includes("About"))?.getAttribute("aria-current")).toBe("page")
    expect(host.querySelector("[role=\"tablist\"], [role=\"tab\"], [role=\"tabpanel\"]")).toBeNull()
    expect(host.querySelector("section[aria-label=\"About settings\"]")?.textContent).toContain("About content")

    await act(async () => root.unmount())
  })
})
