import { Moon, Sun } from "lucide-react"
import { useEffect, useState } from "react"

export type ControlCenterTheme = "dark" | "light"

interface ControlCenterThemeController {
  readonly theme: ControlCenterTheme
  readonly toggleTheme: () => void
}

const storageKey = "cc:ockto-demo:workspace-engineering:theme"

const systemTheme = (): ControlCenterTheme =>
  typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"

const initialTheme = (): ControlCenterTheme => {
  if (typeof window === "undefined") return "light"
  const saved = window.localStorage.getItem(storageKey)
  return saved === "dark" || saved === "light" ? saved : systemTheme()
}

export function useControlCenterTheme(): ControlCenterThemeController {
  const [theme, setTheme] = useState<ControlCenterTheme>(initialTheme)

  useEffect(() => {
    window.localStorage.setItem(storageKey, theme)
  }, [theme])

  return {
    theme,
    toggleTheme: () => setTheme((current) => (current === "dark" ? "light" : "dark"))
  }
}

export function ThemeToggle({
  onToggle,
  theme
}: {
  readonly theme: ControlCenterTheme
  readonly onToggle: () => void
}) {
  const dark = theme === "dark"
  return (
    <button
      aria-label={`Use ${dark ? "light" : "dark"} theme`}
      aria-pressed={dark}
      className="cc-theme-toggle"
      onClick={onToggle}
      title={`Use ${dark ? "light" : "dark"} theme`}
      type="button"
    >
      <span aria-hidden="true">{dark ? <Moon size={14} /> : <Sun size={14} />}</span>
      <small>{dark ? "Dark" : "Light"}</small>
    </button>
  )
}
