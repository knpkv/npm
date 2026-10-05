import {
  createContext,
  type ReactElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore
} from "react"
import { requireText } from "../internal/component.js"
import { GlobalStyles, type GlobalStylesProps } from "./GlobalStyles.js"

const themeNames = <const Names extends ReadonlyArray<string>>(names: Names): Names => names

export const RLY_THEME_NAMES = themeNames(["system", "light", "dark"])
export type RlyTheme = (typeof RLY_THEME_NAMES)[number]

export type ThemeProviderProps = GlobalStylesProps & {
  readonly theme: RlyTheme
}

const ThemeContext = createContext<RlyTheme>("system")

/** Internal bridge used by portal-aware foundations without exposing context internals. */
export const useRlyTheme = (): RlyTheme => useContext(ThemeContext)

/** Controlled theme boundary. Pair it with `useStoredTheme` to remember the viewer's choice. */
export const ThemeProvider = ({ theme, ...props }: ThemeProviderProps): ReactElement => (
  <ThemeContext.Provider value={theme}>
    <GlobalStyles {...props} data-theme={theme} />
  </ThemeContext.Provider>
)

/** Decode an untrusted stored or submitted value into a theme name, or `undefined` when it is not one. */
export const decodeRlyTheme = (value: string | null | undefined): RlyTheme | undefined =>
  value === "system" || value === "light" || value === "dark" ? value : undefined

/** The storage operations `useStoredTheme` needs; the browser's local storage satisfies it. */
export type RlyPreferenceStorage = Pick<Storage, "getItem" | "setItem">

// Same-tab writers notify here; the `storage` event only reaches other tabs.
const sameTabListeners = new Set<(key: string) => void>()
// Holds a choice for this page lifetime when storage writes are refused.
const unsavedThemes = new Map<string, RlyTheme>()

const readStoredTheme = (key: string, storage: () => RlyPreferenceStorage): RlyTheme => {
  const unsaved = unsavedThemes.get(key)
  if (unsaved !== undefined) return unsaved
  try {
    return decodeRlyTheme(storage().getItem(key)) ?? "system"
  } catch {
    return "system"
  }
}

const serverTheme = (): RlyTheme => "system"

/**
 * Remember the viewer's theme under an application-chosen key in storage the
 * application hands in. It is a viewer-local presentation preference, never
 * application data. Pass storage lazily, so server rendering never touches it and
 * a browser that refuses access falls back to `system`.
 *
 * The server snapshot is always `system`, so server-rendered pages hydrate and then
 * switch to the stored theme. Consumers in the same tab and in other tabs stay in sync.
 * When storage refuses the write, the choice lasts until the page unloads.
 *
 * @example
 * // browserStorage is an application function returning the browser's local storage.
 * const [theme, setTheme] = useStoredTheme("jcf_theme", browserStorage)
 * <ThemeProvider theme={theme}><ThemeSelect onValueChange={setTheme} value={theme} /></ThemeProvider>
 */
export const useStoredTheme = (
  storageKey: string,
  storage: () => RlyPreferenceStorage
): readonly [RlyTheme, (theme: RlyTheme) => void] => {
  const key = requireText(storageKey, "useStoredTheme storage key")

  const subscribe = useCallback(
    (notify: () => void): (() => void) => {
      const onStorage = (event: StorageEvent): void => {
        if (event.key === key || event.key === null) notify()
      }
      const onSameTab = (changed: string): void => {
        if (changed === key) notify()
      }
      window.addEventListener("storage", onStorage)
      sameTabListeners.add(onSameTab)
      return () => {
        window.removeEventListener("storage", onStorage)
        sameTabListeners.delete(onSameTab)
      }
    },
    [key]
  )

  const theme = useSyncExternalStore(subscribe, () => readStoredTheme(key, storage), serverTheme)

  // Callers usually pass an inline thunk; a ref keeps setTheme stable across renders.
  const storageRef = useRef(storage)
  useEffect(() => {
    storageRef.current = storage
  })

  const setTheme = useCallback(
    (next: RlyTheme): void => {
      try {
        storageRef.current().setItem(key, next)
        unsavedThemes.delete(key)
      } catch {
        unsavedThemes.set(key, next)
      }
      for (const listener of sameTabListeners) listener(key)
    },
    [key]
  )

  return [theme, setTheme]
}

/**
 * Apply the theme to the document root as well as the rly boundary, so the viewport
 * canvas, overscroll area, and page scrollbars follow the viewer's choice. Call it once,
 * next to `useStoredTheme`, in the application that owns the whole page; embedded rly
 * surfaces should not. The attribute is removed on unmount.
 */
export const useDocumentTheme = (theme: RlyTheme): void => {
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    return () => {
      root.removeAttribute("data-theme")
    }
  }, [theme])
}
