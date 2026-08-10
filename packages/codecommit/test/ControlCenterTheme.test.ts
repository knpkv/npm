import { describe, expect, it } from "@effect/vitest"
import { controlCenterDarkTheme, controlCenterLightTheme, defaultTheme } from "../src/tui/theme/default.js"
import { themes } from "../src/tui/theme/themes.js"

/**
 * Keeps the terminal's default visual language pinned to the shared RLY token
 * contract instead of drifting back to an editor theme.
 */
describe("Control Center TUI theme", () => {
  it("uses the Control Center dark palette as the product default", () => {
    expect(defaultTheme).toBe(controlCenterDarkTheme)
    expect(controlCenterDarkTheme).toMatchObject({
      accentTint: "#302116",
      background: "#101114",
      backgroundElement: "#1e2025",
      backgroundPanel: "#17181c",
      backgroundRaised: "#282a31",
      border: "#30323a",
      borderStrong: "#4c4f5a",
      error: "#ff8b82",
      focus: "#89b7ff",
      primary: "#ff9b55",
      selectedBackground: "#282a31",
      success: "#66d38b",
      text: "#f4f4f6",
      textMuted: "#9396a0",
      warning: "#f0c66a"
    })
  })

  it("keeps the stable dark and light aliases on the Control Center family", () => {
    expect(themes.dark).toBe(controlCenterDarkTheme)
    expect(themes.light).toBe(controlCenterLightTheme)
    expect(themes["control-center-dark"]).toBe(controlCenterDarkTheme)
    expect(themes["control-center-light"]).toBe(controlCenterLightTheme)
  })

  it("uses semantic state tints rather than saturated status fills", () => {
    expect(controlCenterDarkTheme).toMatchObject({
      errorTint: "#3a1918",
      successTint: "#153222",
      warningTint: "#33270f"
    })
    expect(controlCenterLightTheme).toMatchObject({
      errorTint: "#fdecea",
      successTint: "#eaf6ed",
      warningTint: "#fff5dc"
    })
  })
})
